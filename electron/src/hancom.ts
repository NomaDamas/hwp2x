import { access, chmod, copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { log } from "./logger";

const execFileAsync = promisify(execFile);

export interface HancomCandidate {
  path: string;
  name: string;
  version?: string;
  id?: string;
  clsid?: string;
  progId?: string;
  registryView?: "64" | "32";
  hive?: string;
  available?: boolean;
  unavailableReason?: string;
}

export interface PowerShellResult { stdout: string; stderr?: string }
export type PowerShellRunner = (file: string, args: string[], options: { timeout: number; env?: NodeJS.ProcessEnv }) => Promise<PowerShellResult>;

// stdout/stderr come back as bytes: Windows PowerShell 5.1 writes in the console code page (CP949 on Korean
// Windows), so text that is not valid UTF-8 is read as CP949 instead of being turned into U+FFFD garbage.
export function decodeConsoleText(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("euc-kr").decode(bytes); }
}

const runPowerShell: PowerShellRunner = async (file, args, options) => {
  try {
    const result = await execFileAsync(file, args, { ...options, windowsHide: true, encoding: "buffer" });
    return { stdout: decodeConsoleText(result.stdout), stderr: decodeConsoleText(result.stderr) };
  } catch (error) {
    if (error && typeof error === "object") {
      if ("stdout" in error && Buffer.isBuffer(error.stdout)) Object.assign(error, { stdout: decodeConsoleText(error.stdout) });
      if ("stderr" in error && Buffer.isBuffer(error.stderr)) Object.assign(error, { stderr: decodeConsoleText(error.stderr) });
    }
    throw error;
  }
};

const DISCOVERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Get-RegistryDefault {
  param($parent, [string]$subKey)
  $key = if ($subKey) { $parent.OpenSubKey($subKey) } else { $parent }
  if (!$key) { return $null }
  try { return [string]$key.GetValue('') } finally { if ($subKey) { $key.Dispose() } }
}
# Executable path from a LocalServer32 / App Paths / DisplayIcon value. It may be quoted or not, carry
# arguments (-Automation, /Automation, ,0) and use %VAR% variables. Parsing only: callers check the file exists.
function Get-ServerPath {
  param([string]$raw)
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  $expanded = [Environment]::ExpandEnvironmentVariables($raw.Trim())
  $match = [regex]::Match($expanded, '^\s*"(?<exe>[^"]+\.exe)"|^\s*(?<exe>.+?\.exe)(?:\s|,|$)', 'IgnoreCase')
  if (!$match.Success) { return $null }
  return $match.Groups['exe'].Value.Trim().Trim('"')
}
function Add-PathCandidate {
  param([string]$exe, [hashtable]$registration)
  if (!$exe -or !(Test-Path -LiteralPath $exe -PathType Leaf)) { return }
  $full = [IO.Path]::GetFullPath($exe)
  $key = $full.ToLowerInvariant()
  if ($script:seen.ContainsKey($key)) {
    if ($registration -and !$script:seen[$key].available) {
      $script:seen[$key].available = $true
      $script:seen[$key].unavailableReason = $null
      foreach ($name in @('id','clsid','progId','registryView','hive')) { $script:seen[$key].$name = $registration[$name] }
    }
    return
  }
  $vi = [Diagnostics.FileVersionInfo]::GetVersionInfo($full)
  $version = if ($vi.ProductVersion) { $vi.ProductVersion } else { $vi.FileVersion }
  $item = [pscustomobject]@{
    path=$full; name=($(if ($version) { '한컴오피스 한글 ' + $version } else { '한컴오피스 한글' })); version=$version
    id=$null; clsid=$null; progId=$null; registryView=$null; hive=$null
    available=[bool]$registration; unavailableReason=$(if ($registration) { $null } else { '실행 파일은 있지만 COM 등록이 없습니다' })
  }
  if ($registration) { foreach ($name in @('id','clsid','progId','registryView','hive')) { $item.$name = $registration[$name] } }
  $script:seen[$key] = $item
  $script:result.Add($item)
}
$result = [Collections.Generic.List[object]]::new()
$seen = @{}
$views = @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)
$hives = @([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryHive]::CurrentUser)
$knownClsids = @('{2291CF00-64A1-4877-A9B4-68CFE89612F0}')
foreach ($view in $views) {
  foreach ($hive in $hives) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
    try {
      $classes = $base.OpenSubKey('Software\Classes')
      if ($classes) {
        try {
          $progIds = @($classes.GetSubKeyNames() | Where-Object { $_ -match '^HWPFrame\.HwpObject(\.\d+)?$' })
          $registrations = [Collections.Generic.List[hashtable]]::new()
          foreach ($originalProgId in $progIds) {
            $progId = $originalProgId
            $curVer = Get-RegistryDefault $classes "$progId\CurVer"
            if ($curVer -match '^HWPFrame\.HwpObject\.\d+$') { $progId = $curVer }
            $clsid = Get-RegistryDefault $classes "$progId\CLSID"
            if ($clsid -match '^\{[0-9a-fA-F-]{36}\}$') { $registrations.Add(@{ clsid=$clsid; progId=$progId }) }
          }
          foreach ($clsid in $knownClsids) { $registrations.Add(@{ clsid=$clsid; progId='HWPFrame.HwpObject' }) }
          foreach ($registration in $registrations) {
            $server = Get-RegistryDefault $classes ("CLSID\" + $registration.clsid + '\LocalServer32')
            $exe = Get-ServerPath $server
            if (!$exe) { continue }
            $viewName = if ($view -eq [Microsoft.Win32.RegistryView]::Registry64) { '64' } else { '32' }
            $hiveName = if ($hive -eq [Microsoft.Win32.RegistryHive]::LocalMachine) { 'HKLM' } else { 'HKCU' }
            $registration.id = $hiveName + ':' + $viewName + ':' + $registration.clsid
            $registration.registryView = $viewName; $registration.hive = $hiveName
            Add-PathCandidate $exe $registration
          }
        } finally { $classes.Dispose() }
      }
      foreach ($appPath in @('Software\Microsoft\Windows\CurrentVersion\App Paths\Hwp.exe','Software\Microsoft\Windows\CurrentVersion\App Paths\HOffice.exe')) {
        Add-PathCandidate (Get-ServerPath (Get-RegistryDefault $base $appPath)) $null
      }
      foreach ($uninstallRoot in @('Software\Microsoft\Windows\CurrentVersion\Uninstall','Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
        $uninstall = $base.OpenSubKey($uninstallRoot)
        if (!$uninstall) { continue }
        try {
          foreach ($name in @($uninstall.GetSubKeyNames() | Select-Object -First 512)) {
            $product = $uninstall.OpenSubKey($name)
            if (!$product) { continue }
            try {
              $displayName = [string]$product.GetValue('DisplayName')
              if ($displayName -notmatch '한컴|Hancom|Hanword|Hwp') { continue }
              $location = [string]$product.GetValue('InstallLocation')
              # InstallLocation points at different levels per version: the Office folder, HOfficeNN, or Bin.
              if ($location -and (Test-Path -LiteralPath $location -PathType Container)) {
                foreach ($relative in @('Hwp.exe','Bin\Hwp.exe')) { Add-PathCandidate (Join-Path $location $relative) $null }
                foreach ($file in @(Get-ChildItem -LiteralPath $location -Filter Hwp.exe -File -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 16)) { Add-PathCandidate $file.FullName $null }
              }
              Add-PathCandidate (Get-ServerPath ([string]$product.GetValue('DisplayIcon'))) $null
            } finally { $product.Dispose() }
          }
        } finally { $uninstall.Dispose() }
      }
    } finally { $base.Dispose() }
  }
}
# Files on disk: every fixed drive's Program Files plus root-level Hancom folders, since custom installs often
# go to D:\Hnc or C:\Hancom. HOffice90 (2014) .. HOffice130 (2024) and later share the HOfficeNN\Bin layout.
$roots = [Collections.Generic.List[string]]::new()
foreach ($root in @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'), [Environment]::GetEnvironmentVariable('ProgramW6432'))) { if ($root) { $roots.Add($root) } }
foreach ($drive in @([IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady })) {
  foreach ($name in @('Program Files','Program Files (x86)','')) { $roots.Add((Join-Path $drive.RootDirectory.FullName $name)) }
}
foreach ($root in @($roots | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) } | Select-Object -Unique)) {
  foreach ($vendor in @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(HNC|Hnc|Hancom|HancomOffice|한컴|Haansoft)' } | Select-Object -First 8)) {
    foreach ($file in @(Get-ChildItem -LiteralPath $vendor.FullName -Filter Hwp.exe -File -Recurse -Depth 4 -ErrorAction SilentlyContinue | Select-Object -First 32)) { Add-PathCandidate $file.FullName $null }
  }
}
# Korean Windows PowerShell 5.1 writes stdout in the OEM code page (CP949); Base64 of the UTF-8 bytes survives any code page.
$json = [string]($result | ConvertTo-Json -Compress)
if (!$json) { $json = '[]' }
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
`;

/** The conversion script's message when Hancom itself refuses to open a document (kept in sync with the script). */
export const HANCOM_OPEN_FAILED = "한컴 문서 열기에 실패했습니다";
export const HANCOM_INTERACTION_REQUIRED = "사용자 확인이 필요하거나 한컴이 응답하지 않아 처리하지 못했습니다. 원본을 한글에서 직접 열어 암호·숨은 설명·매크로·보안 경고를 확인한 뒤 다시 시도하세요. 경고 승인이나 보안 수준 변경은 자동으로 하지 않습니다";
export const HANCOM_RECOVERY_BLOCKED = "변환용 한글의 안전한 종료를 확인하지 못해 처리를 중단했습니다. 사용자 문서를 저장하고 한글을 직접 종료한 뒤 앱을 다시 시작하세요";

// A native process handle pins the process object, unlike a PID which Windows can reuse.
// The background CLR thread remains runnable while the PowerShell thread is blocked in COM.
const GUARD_SOURCE = String.raw`
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public sealed class Hwp2xGuard {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  delegate bool WindowCallback(IntPtr w, IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr param);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr w, out uint id);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr w);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr w);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr w, uint command);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr w, StringBuilder name, int size);
  readonly IntPtr handle;
  readonly int id;
  readonly Thread worker;
  long deadline = long.MaxValue;
  volatile bool stopping;
  public volatile bool Interrupted;
  public volatile bool Reclaimed;
  public volatile bool Abandoned;
  public Hwp2xGuard(int pid, long created, string exe) {
    id = pid;
    handle = OpenProcess(0x00101000, false, pid);
    long actual, exit, kernel, user;
    var name = new StringBuilder(32768); int size = name.Capacity;
    if (handle == IntPtr.Zero || !GetProcessTimes(handle, out actual, out exit, out kernel, out user) || actual != created || !QueryFullProcessImageName(handle, 0, name, ref size) || !String.Equals(name.ToString(), exe, StringComparison.OrdinalIgnoreCase)) {
      if (handle != IntPtr.Zero) CloseHandle(handle);
      throw new InvalidOperationException("변환용 한글 프로세스의 소유권을 다시 확인하지 못했습니다");
    }
    worker = new Thread(Watch); worker.IsBackground = true;
  }
  public void Start() { worker.Start(); }
  public void Abandon() { Abandoned = true; Console.WriteLine("HWP2X_GUARD:ABANDONED"); }
  bool Modal() {
    bool found = false;
    EnumWindows(delegate(IntPtr w, IntPtr unused) {
      uint pid; GetWindowThreadProcessId(w, out pid);
      if (pid != id || !IsWindowVisible(w)) return true;
      var name = new StringBuilder(256); GetClassName(w, name, name.Capacity);
      IntPtr owner = GetWindow(w, 4);
      if (name.ToString() == "#32770" || (owner != IntPtr.Zero && !IsWindowEnabled(owner))) found = true;
      else { Abandoned = true; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public void Arm(int ms) { Interlocked.Exchange(ref deadline, Stopwatch.GetTimestamp() + (long)ms * Stopwatch.Frequency / 1000); }
  public void Disarm() { Interlocked.Exchange(ref deadline, long.MaxValue); }
  void Watch() {
    try {
      while (WaitForSingleObject(handle, 0) != 0) {
        bool modal = Modal();
        if (Abandoned) { Console.WriteLine("HWP2X_GUARD:ABANDONED"); return; }
        if (stopping || Stopwatch.GetTimestamp() >= Interlocked.Read(ref deadline) || modal) {
          Interrupted = !stopping;
          if (Interrupted) {
            Console.WriteLine("HWP2X_GUARD:INTERRUPTED");
            // Never dismiss a dialog or terminate a process: only accept an observed exit
            // of the pinned process object, which cannot be confused with a reused PID.
            if (WaitForSingleObject(handle, 1000) == 0) {
              Reclaimed = true;
              Console.WriteLine("HWP2X_GUARD:RECLAIMED");
              return;
            }
          }
          Abandon();
          return;
        }
        Thread.Sleep(100);
      }
      Reclaimed = true;
      Console.WriteLine("HWP2X_GUARD:RECLAIMED");
    } catch { } finally { CloseHandle(handle); }
  }
  public bool Stop() {
    stopping = true;
    if ((worker.ThreadState & System.Threading.ThreadState.Unstarted) != 0) { CloseHandle(handle); return false; }
    worker.Join(6000);
    return Reclaimed;
  }
}
`;

const SESSION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
# Progress records would otherwise be serialized to stderr as CLIXML noise.
$ProgressPreference = 'SilentlyContinue'
# Error text is Korean; send it as Base64 of UTF-8 so the console code page cannot garble it.
trap { [Console]::Error.WriteLine('HWP2X_ERROR:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.Exception.Message))); exit 1 }
# Step-by-step trace for the app log (Base64 of UTF-8 JSON, code-page independent).
$clock = [Diagnostics.Stopwatch]::StartNew()
function Trace([string]$step, $data) { [Console]::Out.WriteLine('HWP2X_TRACE:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{ step = $step; ms = $clock.ElapsedMilliseconds; data = $data } | ConvertTo-Json -Compress -Depth 4)))) }
$clsid = [guid]$env:HWP2X_CLSID
$expectedExe = $env:HWP2X_EXE
if (!$clsid) { throw 'Invalid COM candidate' }
# Replies to the app, one line each (Base64 of UTF-8 JSON).
function Reply([string]$kind, $data) { [Console]::Out.WriteLine('HWP2X_' + $kind + ':' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($data | ConvertTo-Json -Compress -Depth 4)))); [Console]::Out.Flush() }
# Hwp.exe processes before our launch, by id and start time (an id can be reused after a process ends).
function Get-HwpProcesses { @(Get-CimInstance Win32_Process -Filter "Name = 'Hwp.exe'" | ForEach-Object { [pscustomobject]@{ Id = [int]$_.ProcessId; Parent = [int]$_.ParentProcessId; Start = $_.CreationDate; Path = $_.ExecutablePath } }) }
$existing = @(Get-HwpProcesses)
$before = @($existing | ForEach-Object { "$($_.Id)|$($_.Start)" })
$launchedAt = Get-Date
Trace 'before' @{ hwp = @($existing | ForEach-Object { @{ id = $_.Id; parent = $_.Parent; path = $_.Path } }) }
$hwp = $null
$ownsInstance = $false
$guard = $null
try {
  $type = [Type]::GetTypeFromCLSID($clsid, $true)
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class Hwp2xWindow { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId); }'
  $hwp = [Activator]::CreateInstance($type)
  Trace 'com-created' @{ clsid = [string]$clsid }
  # Bind the COM window to its actual process; a concurrent user launch is not proof of ownership.
  $window = $hwp.XHwpWindows.Item(0)
  $handle = [IntPtr]$window.WindowHandle
  [uint32]$comProcessId = 0
  if ($handle -eq [IntPtr]::Zero) { throw '변환용 한글 창의 소유권을 확인하지 못했습니다' }
  [void][Hwp2xWindow]::GetWindowThreadProcessId($handle, [ref]$comProcessId)
  $fresh = @(Get-HwpProcesses | Where-Object { $before -notcontains "$($_.Id)|$($_.Start)" -and $_.Start -ge $launchedAt.AddSeconds(-2) })
  $ours = @($fresh | Where-Object { $_.Id -eq $comProcessId })
  $ours = @($ours | Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Parent)" -ErrorAction SilentlyContinue).Name -eq 'svchost.exe' })
  Trace 'identified' @{ fresh = @($fresh | ForEach-Object { @{ id = $_.Id; parent = $_.Parent; path = $_.Path } }); ours = @($ours | ForEach-Object { $_.Id }) }
  # The session starts while no other launch of ours is in flight (convertWithHancom runs one job at a time). No new process means COM attached to an Hwp.exe that was
  # already open (possibly the user's): it is never used or closed.
  if ($ours.Count -eq 0) { throw '이미 열려 있는 한글 창에 연결되어 변환을 멈췄습니다(사용자 문서 보호). 한글 창을 모두 닫고 다시 변환해 주세요' }
  if ($ours.Count -ne 1) { throw "변환용 한글을 하나로 특정하지 못했습니다(새 한글 $($ours.Count)개). 다른 한글 실행이 끝난 뒤 다시 변환해 주세요" }
  $exe = $ours[0].Path
  if (!$exe -or ($expectedExe -and [IO.Path]::GetFullPath($exe) -ne [IO.Path]::GetFullPath($expectedExe))) { throw "선택한 한컴 실행 파일과 실제로 실행된 한글이 다릅니다: $exe" }
  $ownsInstance = $true
  [Console]::Out.WriteLine('HWP2X_GUARD:OWNED')
  $documentCount = [int]$hwp.XHwpDocuments.Count
  Add-Type -TypeDefinition $env:HWP2X_GUARD_SOURCE
  $guard = New-Object Hwp2xGuard([int]$ours[0].Id, ([datetime]$ours[0].Start).ToUniversalTime().ToFileTimeUtc(), $exe)
  # Only an empty automation instance can be claimed; existing tabs are never ours.
  if ($documentCount -ne 0 -or [int]$hwp.XHwpWindows.Count -ne 1) { $guard.Abandon(); throw $env:HWP2X_INTERACTION_REQUIRED }
  $guard.Arm([int]$env:HWP2X_TIMEOUT)
  $windows = $hwp.XHwpWindows
  for ($index = 0; $index -lt $windows.Count; $index++) { $windows.Item($index).Visible = $false }
  $guard.Start()
  # Approve file access for this automation instance so Hwp.exe does not ask "한글을 이용하여 위 파일에 접근하려는
  # 시도가 있습니다" for every document. Hancom looks the module up by name under HKCU (current user only, no admin);
  # the DLL must match Hwp.exe's bitness. Registered only on our own instance: the user's Hangul windows are untouched.
  $moduleDll = $env:HWP2X_FILEPATH_MODULE
  $exeIs64 = $false
  try { $stream = [IO.File]::OpenRead($exe); $reader = New-Object IO.BinaryReader($stream); $stream.Position = 0x3C; $stream.Position = $reader.ReadInt32() + 4; $exeIs64 = $reader.ReadUInt16() -eq 0x8664 } catch {} finally { if ($stream) { $stream.Dispose() } }
  if ($moduleDll) { $moduleDll = $moduleDll.Replace('{arch}', $(if ($exeIs64) { 'x64' } else { 'x86' })) }
  $approved = $false
  if ($moduleDll -and (Test-Path -LiteralPath $moduleDll -PathType Leaf)) {
    try {
      $modules = 'HKCU:\Software\HNC\HwpAutomation\Modules'
      if (!(Test-Path -LiteralPath $modules)) { New-Item -Path $modules -Force | Out-Null }
      New-ItemProperty -LiteralPath $modules -Name 'FilePathCheckerModule' -Value $moduleDll -PropertyType String -Force | Out-Null
      $approved = [bool]$hwp.RegisterModule('FilePathCheckDLL', 'FilePathCheckerModule')
    } catch { Trace 'approve-error' @{ error = [string]$_.Exception.Message } }
  }
  Trace 'approve' @{ module = $moduleDll; hwp64 = $exeIs64; ok = $approved }
  if (!$approved) { throw '파일 접근 보안 모듈을 등록하지 못해 대화상자 방지를 위해 변환을 중단했습니다' }
  # Hwp.exe is ready: from here on it is reused for every document until the app ends the session (stdin closes).
  $guard.Disarm()
  Reply 'READY' @{ ready = $true }
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ($line -eq 'ABANDON') { $guard.Abandon(); break }
    if (!$line.Trim()) { continue }
    # Each job is Base64 of UTF-8 JSON {source,tempOutput}: paths survive any console input code page.
    $job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Trim())) | ConvertFrom-Json
    $source = [string]$job.source
    $tempOutput = [string]$job.tempOutput
    try {
      $guard.Arm([int]$env:HWP2X_TIMEOUT)
      if ([int]$hwp.XHwpWindows.Count -ne 1) { $guard.Abandon() }
      if ([int]$hwp.XHwpDocuments.Count -gt $documentCount) { $guard.Abandon() }
      if ($guard.Abandoned) { throw $env:HWP2X_INTERACTION_REQUIRED }
      # Keep our window hidden before every document (Hancom may show it again after a dialog or a Clear).
      $windows = $hwp.XHwpWindows
      for ($index = 0; $index -lt $windows.Count; $index++) { $windows.Item($index).Visible = $false }
      if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Invalid source' }
      # Let Hancom detect the format first ('' = auto: HWP 3.x, HWPML and distribution documents are not 'HWP'),
      # then the explicit HWP filter; suppress the password and version dialogs that make Open return false.
      $opened = $false
      foreach ($attempt in @(@('', 'forceopen:true;suspendpassword:true;versionwarning:false'), @('HWP', 'forceopen:true;suspendpassword:true;versionwarning:false'))) {
        try { $opened = [bool]$hwp.Open($source, $attempt[0], $attempt[1]) } catch { $opened = $false; Trace 'open-error' @{ format = $attempt[0]; error = [string]$_.Exception.Message } }
        if ($guard.Interrupted -or $guard.Abandoned) { throw $env:HWP2X_INTERACTION_REQUIRED }
        Trace 'open-try' @{ format = $attempt[0]; arg = $attempt[1]; ok = $opened }
        if ($opened) { break }
      }
      if (!$opened) {
        $head = New-Object byte[] 8
        $stream = [IO.File]::OpenRead($source)
        try { $count = $stream.Read($head, 0, $head.Length); $head = @($head | Select-Object -First $count) } finally { $stream.Dispose() }
        Trace 'open-failed' @{ size = (Get-Item -LiteralPath $source).Length; head = (($head | ForEach-Object { $_.ToString('X2') }) -join ' ') }
        throw '한컴 문서 열기에 실패했습니다'
      }
      Trace 'opened' $null
      if ([int]$hwp.XHwpDocuments.Count -gt ($documentCount + 1)) { $guard.Abandon() }
      if ($guard.Abandoned) { throw $env:HWP2X_INTERACTION_REQUIRED }
      if ($hwp.SaveAs($tempOutput, 'HWPX', '') -ne $true) { throw '한컴 HWPX 저장에 실패했습니다' }
      if ($guard.Interrupted -or $guard.Abandoned) { throw $env:HWP2X_INTERACTION_REQUIRED }
      if (!(Test-Path -LiteralPath $tempOutput -PathType Leaf) -or (Get-Item -LiteralPath $tempOutput).Length -lt 4) { throw '한컴 HWPX 출력이 생성되지 않았습니다' }
      $bytes = New-Object byte[] 2
      $stream = [IO.File]::OpenRead($tempOutput)
      try { $count = $stream.Read($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
      if ($count -ne 2 -or $bytes[0] -ne 0x50 -or $bytes[1] -ne 0x4b) { throw '한컴 출력이 HWPX ZIP이 아닙니다' }
      # Clear must succeed before acknowledging or accepting another document.
      if ([int]$hwp.XHwpDocuments.Count -gt ($documentCount + 1)) { $guard.Abandon() }
      if ($guard.Abandoned) { throw $env:HWP2X_INTERACTION_REQUIRED }
      $hwp.Clear(1) | Out-Null
      if ($guard.Interrupted) { throw $env:HWP2X_INTERACTION_REQUIRED }
      $guard.Disarm()
      Reply 'DONE' @{ ok = $true }
    } catch {
      if ($guard.Interrupted) { throw $env:HWP2X_INTERACTION_REQUIRED }
      Reply 'DONE' @{ ok = $false; error = [string]$_.Exception.Message }
      break
    }
  }
} finally {
  if ($hwp) {
    if ($guard -and !$guard.Interrupted -and !$guard.Abandoned) {
      if ([int]$hwp.XHwpWindows.Count -ne 1) { $guard.Abandon() }
      try { if ([int]$hwp.XHwpDocuments.Count -gt $documentCount) { $guard.Abandon() } } catch { $guard.Abandon() }
    }
    if ($ownsInstance -and $guard -and !$guard.Interrupted -and !$guard.Abandoned) { $guard.Arm(3000); try { $hwp.Quit() } catch {} }
    if (!$guard -or (!$guard.Interrupted -and !$guard.Abandoned)) { try { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($hwp) } catch {} }
  }
  if ($guard) { [void]$guard.Stop() }
}
`;

function encodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Decodes the discovery script's stdout: Base64 of UTF-8 JSON (code-page independent). */
export function decodeDiscoveryOutput(stdout: string): string {
  const text = stdout.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) throw new Error("Hancom discovery returned invalid JSON: expected Base64 of UTF-8 JSON");
  return Buffer.from(text, "base64").toString("utf8");
}

const ERROR_MARKER = /HWP2X_ERROR:([A-Za-z0-9+/=]+)/;

/** Turns a conversion-script failure into one readable line: never the encoded command, CLIXML or garbled (U+FFFD) text. */
export function conversionErrorMessage(error: unknown): string {
  const stderr = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  const message = error instanceof Error ? error.message : String(error);
  const marked = ERROR_MARKER.exec(stderr) ?? ERROR_MARKER.exec(message);
  if (marked) return Buffer.from(marked[1]!, "base64").toString("utf8");
  if (error && typeof error === "object" && "killed" in error && error.killed) return "한컴 변환이 제한 시간 안에 끝나지 않았습니다";
  // PowerShell's own error (CLIXML): the first <S S="Error"> line is the error text.
  const clixml = /<S S="Error">([^<]*)<\/S>/.exec(stderr || message)?.[1]?.replace(/_x000D__x000A_/g, "").trim();
  const text = clixml || (/^Command failed:/.test(message) ? stderr.trim().split(/\r?\n/)[0] ?? "" : message);
  return !text || text.includes("\uFFFD") || /-EncodedCommand|#< CLIXML/.test(text) ? "한컴 변환에 실패했습니다" : text;
}

export function parseDiscoveryOutput(stdout: string): HancomCandidate[] {
  let value: unknown;
  try { value = JSON.parse(stdout.replace(/^\uFEFF/, "").trim() || "[]"); }
  catch (error) { throw new Error(`Hancom discovery returned invalid JSON: ${String(error)}`); }
  const result: HancomCandidate[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value) ? value : value == null ? [] : [value]) {
    if (!item || typeof item !== "object" || typeof item.path !== "string" || !item.path.trim()) continue;
    const exe = item.path.trim();
    if (!/hwp\.exe$/i.test(exe) || !(path.win32.isAbsolute(exe) || path.isAbsolute(exe))) continue;
    const raw = typeof item.clsid === "string" ? item.clsid.trim().replace(/^\{|\}$/g, "") : "";
    const clsid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(raw) ? `{${raw.toUpperCase()}}` : undefined;
    const version = typeof item.version === "string" ? item.version.trim() : undefined;
    // A name that arrives garbled (U+FFFD: text decoded with the wrong code page somewhere on the way) is
    // never shown; it is rebuilt from the version, which is plain ASCII and survives any encoding.
    const given = typeof item.name === "string" ? item.name.trim() : "";
    const name = given && !given.includes("\uFFFD") ? given : `한컴오피스 한글${version ? ` ${version}` : ""}`;
    // HWPX saving began with 한글 2010 (product version 8.0). Detected names carry the file version
    // ("한컴오피스 한글 6.5.0.1000" for 2004), so the version number decides, with the year name as a fallback.
    const major = Number(/^(\d+)\./.exec(version ?? "")?.[1] ?? /한글\s+(\d+)\.\d/.exec(name)?.[1] ?? NaN);
    const legacy = /(?:^|\D)(?:97|2002|2004|2005|2007)(?:\D|$)/.test(name) || (Number.isFinite(major) && major < 8);
    const available = item.available !== false && !!clsid && !legacy;
    const candidate: HancomCandidate = {
      path: exe, name, version, clsid, available,
      registryView: item.registryView === "32" || item.registryView === "64" ? item.registryView : undefined,
      hive: typeof item.hive === "string" ? item.hive : undefined,
      progId: typeof item.progId === "string" ? item.progId : undefined,
      unavailableReason: legacy ? `${name}은(는) HWPX 저장을 지원하지 않습니다(한글 2010 이상 필요). HWPX 저장 가능한 한글을 선택하거나 kordoc 대체 엔진을 사용하세요.` : available ? undefined : typeof item.unavailableReason === "string" ? item.unavailableReason : "유효한 COM 등록을 확인하지 못했습니다. 한컴 설치 복구 후 다시 감지하거나 kordoc을 선택하세요.",
    };
    const key = `${path.win32.normalize(exe).toLowerCase()}|${clsid ?? ""}|${candidate.registryView ?? ""}|${candidate.hive ?? ""}`;
    if (!seen.has(key)) { seen.add(key); result.push(candidate); }
  }
  return result;
}

export async function inspectHancomPath(exe: string, platform = process.platform, runner: PowerShellRunner = runPowerShell): Promise<HancomCandidate> {
  // HWP2X_FAKE_HANCOM(_FILE) (explicit test list, see detectHancom) lets the real pick → save → restart flow run on Linux.
  if (platform !== "win32" && !process.env.HWP2X_FAKE_HANCOM && !process.env.HWP2X_FAKE_HANCOM_FILE) throw new Error("한컴 변환은 Windows에서만 사용할 수 있습니다");
  if (!path.isAbsolute(exe)) throw new Error("한컴 감지 경로는 절대 경로여야 합니다");
  let info;
  try { info = await stat(exe); } catch { throw new Error("한컴 실행 파일을 찾을 수 없습니다"); }
  if (!info.isFile() || path.basename(exe).toLowerCase() !== "hwp.exe") throw new Error("한컴 실행 파일(Hwp.exe)이 아닙니다");

  let all: HancomCandidate[];
  try { all = await detectHancom(platform, runner); }
  catch (error) {
    return { path: exe, name: "직접 선택한 한글", available: false,
      unavailableReason: `선택 경로는 저장할 수 있지만 자동화 연결 확인에 실패했습니다: ${String(error)}. 한컴 설치 복구 후 다시 감지하거나 kordoc을 선택하세요.` };
  }
  // Windows paths are case-insensitive and accept both separators; compare them that way on every OS.
  const windowsKey = (value: string) => path.win32.normalize(value.replaceAll("/", "\\")).toLowerCase();
  const match = all.find(c => windowsKey(c.path) === windowsKey(exe));
  if (match) return match;

  return {
    path: path.normalize(exe),
    name: "한컴오피스 한글 (알 수 없음)",
    available: false,
    unavailableReason: "선택한 실행 파일과 연결된 COM 등록이 없습니다. 한컴 설치 복구 후 다시 감지하세요. 한글 2004는 HWPX 저장을 지원하지 않으므로 지원 버전 또는 kordoc을 선택해야 합니다.",
  };
}

export async function detectHancom(platform = process.platform, runner: PowerShellRunner = runPowerShell): Promise<HancomCandidate[]> {
  // The test list goes through the same checks as real PowerShell output (version, COM class, 2004 rule).
  // HWP2X_FAKE_HANCOM_FILE is read on every detection, so a check can install/remove a version while the app runs.
  if (process.env.HWP2X_FAKE_HANCOM_FILE) return parseDiscoveryOutput(await readFile(process.env.HWP2X_FAKE_HANCOM_FILE, "utf8"));
  if (process.env.HWP2X_FAKE_HANCOM) return parseDiscoveryOutput(process.env.HWP2X_FAKE_HANCOM);
  if (platform !== "win32") return [];
  const encoded = encodedCommand(DISCOVERY_SCRIPT);
  try {
    const shell = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
    const { stdout } = await runner(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { timeout: 10000 });
    return parseDiscoveryOutput(decodeDiscoveryOutput(stdout));
  } catch (error) {
    throw new Error(`Hancom discovery failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Where the file-access approval module lives, with "{arch}" for x86/x64 (chosen by the script from Hwp.exe).
 * Packaged: resources/hancom/{arch}/ (extraResources); running from the project: electron/native/{arch}/.
 */
export function filePathModulePattern(resourcesPath: string | undefined = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath): string {
  const packaged = resourcesPath ? path.join(resourcesPath, "hancom", "{arch}", "FilePathCheckerModule.dll") : "";
  return packaged && existsSync(packaged.replace("{arch}", "x64")) ? packaged : path.join(__dirname, "..", "native", "{arch}", "FilePathCheckerModule.dll");
}

export function buildConversionInvocation(candidate: HancomCandidate, source: string, tempOutput: string, modulePattern = filePathModulePattern()): { script: string; file: string; env: NodeJS.ProcessEnv } {
  if (!candidate.clsid || !/^\{[0-9a-fA-F-]{36}\}$/.test(candidate.clsid)) throw new Error("선택한 한컴 설치에는 유효한 COM CLSID가 없습니다");
  const root = process.env.SystemRoot || "C:\\Windows";
  const file = candidate.registryView === "32" ? path.join(root, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe") : path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return { script: SESSION_SCRIPT, file, env: { ...process.env, HWP2X_CLSID: candidate.clsid, HWP2X_SOURCE: source, HWP2X_TARGET: tempOutput, HWP2X_EXE: candidate.path, HWP2X_FILEPATH_MODULE: modulePattern, HWP2X_GUARD_SOURCE: GUARD_SOURCE, HWP2X_TIMEOUT: "120000", HWP2X_INTERACTION_REQUIRED: HANCOM_INTERACTION_REQUIRED } };
}

const TRACE_MARKER = /HWP2X_TRACE:([A-Za-z0-9+/=]+)/g;

/** Steps the conversion script reported (process ids before/after, which Hwp.exe was ours, ...), in order. */
export function conversionTrace(output: string): unknown[] {
  const steps: unknown[] = [];
  for (const match of output.matchAll(TRACE_MARKER)) {
    try { steps.push(JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8"))); } catch { /* a cut-off line carries nothing usable */ }
  }
  return steps;
}

export type HancomSessionSpawner = (file: string, args: string[], options: { windowsHide: true; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
export interface HancomSessionOptions { spawn?: HancomSessionSpawner; idleMs?: number; timeoutMs?: number; stopMs?: number }
const defaultSpawner: HancomSessionSpawner = (file, args, options) => spawn(file, args, options);
let hancomQueue: Promise<unknown> = Promise.resolve();
let activeSession: HancomSession | undefined;
let shuttingDown = false;
export function hancomProcessCount(): number {
  return activeSession && !activeSession.unavailable ? 1 : 0;
}
let recoveryBlocked = false;

class HancomSession {
  private pending?: { kind: string; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  private buffer = "";
  private stderr = "";
  private idle?: NodeJS.Timeout;
  private stopped = false;
  private closing?: Promise<void>;
  private owned = false;
  private reclaimed = false;
  private abandoned = false;
  private readonly exited: Promise<void>;
  private exitResolve!: () => void;
  readonly ready: Promise<void>;
  readonly child: ChildProcessWithoutNullStreams;
  constructor(readonly key: string, readonly options: HancomSessionOptions, invocation: ReturnType<typeof buildConversionInvocation>) {
    this.exited = new Promise(resolve => { this.exitResolve = resolve; });
    this.child = (options.spawn ?? defaultSpawner)(invocation.file, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand(invocation.script)], { windowsHide: true, env: { ...invocation.env, HWP2X_TIMEOUT: String(options.timeoutMs ?? 120000) } });
    this.ready = this.wait("READY");
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr += decodeConsoleText(chunk); });
    this.child.stdin.on("error", (error: Error) => this.fail(error));
    this.child.on("error", (error: Error) => { this.fail(error); this.stopped = true; this.exitResolve(); });
    this.child.on("close", () => {
      this.stopped = true;
      this.fail(new Error(conversionErrorMessage({ stderr: this.stderr, toString: () => "한컴 세션이 예기치 않게 종료되었습니다" })));
      this.exitResolve();
    });
  }
  private fail(error: Error): void {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = undefined; }
  }
  private abandon(): void {
    if (this.abandoned) return;
    this.abandoned = true;
    recoveryBlocked = true;
    clearTimeout(this.idle);
    if (!this.child.stdin.writableEnded && !this.child.stdin.destroyed) this.child.stdin.write("ABANDON\n");
    this.child.unref();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.child.stdin.end();
    this.fail(new Error(HANCOM_RECOVERY_BLOCKED));
  }
  private wait(kind: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.abandon(), this.options.timeoutMs ?? 120000);
      this.pending = { kind, resolve, reject, timer };
    });
  }
  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 1024 * 1024) { this.fail(new Error("한컴 세션 응답이 너무 큽니다")); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (line.startsWith("HWP2X_TRACE:")) { log("info", "hancom.session", { steps: conversionTrace(line) }); continue; }
      if (line === "HWP2X_GUARD:OWNED") { this.owned = true; continue; }
      if (line === "HWP2X_GUARD:RECLAIMED") { this.reclaimed = true; continue; }
      if (line === "HWP2X_GUARD:INTERRUPTED") { this.fail(new Error(HANCOM_INTERACTION_REQUIRED)); continue; }
      if (line === "HWP2X_GUARD:ABANDONED") { this.abandon(); return; }
      try {
        const match = /^HWP2X_(READY|DONE):([A-Za-z0-9+/=]+)$/.exec(line);
        if (!match || !this.pending || match[1] !== this.pending.kind) throw new Error("한컴 세션 응답을 해석하지 못했습니다");
        const data: unknown = JSON.parse(decodeDiscoveryOutput(match[2]!));
        if (!data || typeof data !== "object") throw new Error("한컴 세션 응답을 해석하지 못했습니다");
        if (match[1] === "READY" ? !("ready" in data && data.ready === true) : !("ok" in data && data.ok === true)) {
          throw new Error("error" in data && typeof data.error === "string" ? data.error : "한컴 세션 응답을 해석하지 못했습니다");
        }
        const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer); pending.resolve();
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    }
  }
  get unavailable(): boolean { return this.stopped || this.closing !== undefined; }
  async run(source: string, tempOutput: string): Promise<void> {
    clearTimeout(this.idle);
    await this.ready;
    if (this.stopped || this.closing) throw new Error("한컴 세션이 종료되었습니다");
    const done = this.wait("DONE");
    this.child.stdin.write(Buffer.from(JSON.stringify({ source, tempOutput }), "utf8").toString("base64") + "\n");
    await done;
  }
  armIdle(): void {
    this.idle = setTimeout(() => { void this.close().catch(error => log("warn", "hancom.close", { error: String(error) })); }, this.options.idleMs ?? 30000);
    this.idle.unref();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    clearTimeout(this.idle);
    if (this.abandoned) return Promise.reject(new Error(HANCOM_RECOVERY_BLOCKED));
    this.fail(new Error("한컴 세션을 종료합니다"));
    this.closing = (async () => {
      if (!this.stopped) {
        this.child.stdin.end();
        {
          await Promise.race([this.exited, new Promise<never>((_, reject) => {
            const deadline = setTimeout(() => { this.abandon(); reject(new Error(HANCOM_RECOVERY_BLOCKED)); }, this.options.stopMs ?? 5000);
            this.exited.then(() => clearTimeout(deadline));
          })]);
        }
      }
      if (this.owned && !this.reclaimed) { recoveryBlocked = true; throw new Error(HANCOM_RECOVERY_BLOCKED); }
    })();
    return this.closing;
  }
}

export async function closeHancomSession(): Promise<void> {
  shuttingDown = true;
  const session = activeSession; activeSession = undefined;
  await session?.close();
  await hancomQueue;
}

export function convertWithHancom(candidate: HancomCandidate, source: string, target: string, platform = os.platform(), options: HancomSessionOptions = {}): Promise<void> {
  if (shuttingDown) return Promise.reject(new Error("앱 종료 중에는 한컴 변환을 시작할 수 없습니다"));
  const run = hancomQueue.then(() => {
    if (shuttingDown) throw new Error("앱 종료 중에는 한컴 변환을 시작할 수 없습니다");
    return convertWithHancomNow(candidate, source, target, platform, options);
  });
  hancomQueue = run.catch(() => undefined);
  return run;
}

async function convertWithHancomNow(candidate: HancomCandidate, source: string, target: string, platform: string, options: HancomSessionOptions): Promise<void> {
  if (platform !== "win32") throw new Error("한컴 변환은 Windows에서만 사용할 수 있습니다");
  if (candidate.available === false) throw new Error(`선택한 한컴 버전을 사용할 수 없습니다: ${candidate.unavailableReason ?? "사용할 수 없음"}`);
  if (!candidate.clsid) throw new Error("선택한 한컴 설치에는 유효한 COM CLSID가 없습니다");
  if (!path.isAbsolute(source) || !path.isAbsolute(target)) throw new Error("한컴 변환 경로는 절대 경로여야 합니다");
  await access(source);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hwp2x-hancom-"));
  const tempOutput = path.join(tempDir, `${randomUUID()}.hwpx`);
  try {
    // Hwp.exe never sees the original: it opens a read-only copy in our temporary folder, so neither an
    // autosave, a backup (.bak) file nor a stray Save can ever write to the user's HWP. The copy keeps the
    // extension so Hancom detects the format the same way.
    const working = path.join(tempDir, `source${path.extname(source).toLowerCase() || ".hwp"}`);
    await copyFile(source, working);
    await chmod(working, 0o444);
    const invocation = buildConversionInvocation(candidate, working, tempOutput);
    const started = Date.now();
    try {
      if (shuttingDown) throw new Error("앱 종료 중에는 한컴 변환을 시작할 수 없습니다");
      if (recoveryBlocked) throw new Error(HANCOM_RECOVERY_BLOCKED);
      const key = JSON.stringify([candidate.path, candidate.clsid, candidate.registryView]);
      if (activeSession && (activeSession.unavailable || activeSession.key !== key || activeSession.options.spawn !== options.spawn)) {
        await activeSession.close(); activeSession = undefined;
      }
      if (shuttingDown) throw new Error("앱 종료 중에는 한컴 변환을 시작할 수 없습니다");
      if (!activeSession) activeSession = new HancomSession(key, options, invocation);
      await activeSession.run(working, tempOutput);
      activeSession.armIdle();
      log("info", "hancom.run", { source, ms: Date.now() - started });
    } catch (error) {
      const failed = activeSession; activeSession = undefined;
      await failed?.close();
      const stdout = error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
      const message = conversionErrorMessage(error);
      log("warn", "hancom.run", { source, ms: Date.now() - started, error: message, steps: conversionTrace(stdout) });
      throw new Error(message);
    }
    const info = await stat(tempOutput);
    if (!info.isFile() || info.size < 4) throw new Error("한컴 HWPX 출력이 없습니다");
    const magic = await readFile(tempOutput, { encoding: null });
    if (magic[0] !== 0x50 || magic[1] !== 0x4b) throw new Error("한컴 출력이 HWPX ZIP이 아닙니다");
    await copyFile(tempOutput, target);
  } finally {
    // Windows refuses to delete a read-only file; give the copy write permission back before removing the folder.
    await chmod(path.join(tempDir, `source${path.extname(source).toLowerCase() || ".hwp"}`), 0o644).catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
  }
}
