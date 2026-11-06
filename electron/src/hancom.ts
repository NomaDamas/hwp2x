import { access, copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

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

const runPowerShell: PowerShellRunner = async (file, args, options) => {
  const result = await execFileAsync(file, args, { ...options, windowsHide: true });
  return { stdout: result.stdout, stderr: result.stderr };
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
              foreach ($relative in @('Hwp.exe','Bin\Hwp.exe','HOffice130\Bin\Hwp.exe')) { if ($location) { Add-PathCandidate (Join-Path $location $relative) $null } }
              Add-PathCandidate (Get-ServerPath ([string]$product.GetValue('DisplayIcon'))) $null
            } finally { $product.Dispose() }
          }
        } finally { $uninstall.Dispose() }
      }
    } finally { $base.Dispose() }
  }
}
foreach ($root in @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) | Where-Object { $_ } | Select-Object -Unique) {
  foreach ($relative in @('HNC\Office\HOffice130\Bin\Hwp.exe','HNC\HOffice130\Bin\Hwp.exe')) { Add-PathCandidate (Join-Path $root $relative) $null }
  foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $root 'HNC') -Filter Hwp.exe -File -Recurse -Depth 4 -ErrorAction SilentlyContinue | Select-Object -First 64)) { Add-PathCandidate $file.FullName $null }
}
$result | ConvertTo-Json -Compress
`;

const CONVERSION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$clsid = [guid]$env:HWP2X_CLSID
$source = $env:HWP2X_SOURCE
$tempOutput = $env:HWP2X_TARGET
$expectedExe = $env:HWP2X_EXE
if (!$clsid -or !(Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Invalid COM candidate or source' }
$before = @(Get-CimInstance Win32_Process -Filter "Name = 'Hwp.exe'" | Select-Object -ExpandProperty ProcessId)
$hwp = $null
$ownsInstance = $false
try {
  $type = [Type]::GetTypeFromCLSID($clsid, $true)
  $hwp = [Activator]::CreateInstance($type)
  $after = @(Get-CimInstance Win32_Process -Filter "Name = 'Hwp.exe'" | Select-Object -ExpandProperty ProcessId)
  $newPid = @($after | Where-Object { $before -notcontains $_ })
  if ($newPid.Count -ne 1) { throw '한컴 COM 인스턴스를 새로 만들지 못했습니다' }
  $exe = (Get-CimInstance Win32_Process -Filter "ProcessId = $($newPid[0])").ExecutablePath
  if (!$exe -or ($expectedExe -and [IO.Path]::GetFullPath($exe) -ne [IO.Path]::GetFullPath($expectedExe))) { throw '선택한 한컴 실행 파일과 COM 서버가 다릅니다' }
  $ownsInstance = $true
  if ($hwp.Open($source, 'HWP', 'forceopen:true') -ne $true) { throw '한컴 문서 열기에 실패했습니다' }
  if ($hwp.SaveAs($tempOutput, 'HWPX', '') -ne $true) { throw '한컴 HWPX 저장에 실패했습니다' }
  if (!(Test-Path -LiteralPath $tempOutput -PathType Leaf) -or (Get-Item -LiteralPath $tempOutput).Length -lt 4) { throw '한컴 HWPX 출력이 생성되지 않았습니다' }
  $bytes = [IO.File]::ReadAllBytes($tempOutput)
  if ($bytes[0] -ne 0x50 -or $bytes[1] -ne 0x4b) { throw '한컴 출력이 HWPX ZIP이 아닙니다' }
} finally {
  if ($hwp) {
    if ($ownsInstance) { try { $hwp.Quit() } catch {} }
    try { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($hwp) } catch {}
  }
}
`;

function encodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function validCandidate(value: unknown): value is HancomCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HancomCandidate>;
  return typeof candidate.path === "string" && typeof candidate.name === "string" &&
    (candidate.clsid === undefined || /^\{[0-9a-fA-F-]{36}\}$/.test(candidate.clsid));
}

export function parseDiscoveryOutput(stdout: string): HancomCandidate[] {
  let value: unknown;
  try { value = JSON.parse(stdout.trim() || "[]"); } catch (error) { throw new Error(`Hancom discovery returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const values = Array.isArray(value) ? value : [value];
  if (!values.every(validCandidate)) throw new Error("Hancom discovery returned an invalid candidate");
  const seen = new Set<string>();
  return values.filter((candidate) => {
    const key = `${candidate.clsid ?? candidate.path}|${candidate.registryView ?? ""}|${candidate.hive ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function inspectHancomPath(exe: string, platform = process.platform, runner: PowerShellRunner = runPowerShell): Promise<HancomCandidate> {
  if (platform !== "win32") throw new Error("한컴 변환은 Windows에서만 사용할 수 있습니다");
  if (!path.isAbsolute(exe)) throw new Error("한컴 감지 경로는 절대 경로여야 합니다");
  let info;
  try { info = await stat(exe); } catch { throw new Error("한컴 실행 파일을 찾을 수 없습니다"); }
  if (!info.isFile() || path.basename(exe).toLowerCase() !== "hwp.exe") throw new Error("한컴 실행 파일(Hwp.exe)이 아닙니다");

  const all = await detectHancom(platform, runner);
  // Windows paths are case-insensitive and accept both separators; compare them that way on every OS.
  const windowsKey = (value: string) => path.win32.normalize(value.replaceAll("/", "\\")).toLowerCase();
  const match = all.find(c => windowsKey(c.path) === windowsKey(exe));
  if (match) return match;

  return {
    path: path.normalize(exe),
    name: "한컴오피스 한글 (알 수 없음)",
    available: false,
    unavailableReason: "COM 등록 없음 (직접 선택한 인스턴스)",
  };
}

export async function detectHancom(platform = process.platform, runner: PowerShellRunner = runPowerShell): Promise<HancomCandidate[]> {
  if (process.env.HWP2X_FAKE_HANCOM) return JSON.parse(process.env.HWP2X_FAKE_HANCOM) as HancomCandidate[];
  if (platform !== "win32") return [];
  const encoded = encodedCommand(DISCOVERY_SCRIPT);
  try {
    const shell = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
    const { stdout } = await runner(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { timeout: 10000 });
    return parseDiscoveryOutput(stdout);
  } catch (error) {
    throw new Error(`Hancom discovery failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}


export function buildConversionInvocation(candidate: HancomCandidate, source: string, tempOutput: string): { script: string; file: string; env: NodeJS.ProcessEnv } {
  if (!candidate.clsid || !/^\{[0-9a-fA-F-]{36}\}$/.test(candidate.clsid)) throw new Error("선택한 한컴 설치에는 유효한 COM CLSID가 없습니다");
  const root = process.env.SystemRoot || "C:\\Windows";
  const file = candidate.registryView === "32" ? path.join(root, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe") : path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return { script: CONVERSION_SCRIPT, file, env: { ...process.env, HWP2X_CLSID: candidate.clsid, HWP2X_SOURCE: source, HWP2X_TARGET: tempOutput, HWP2X_EXE: candidate.path } };
}

export async function convertWithHancom(candidate: HancomCandidate, source: string, target: string, platform = os.platform(), runner: PowerShellRunner = runPowerShell): Promise<void> {
  if (platform !== "win32") throw new Error("한컴 변환은 Windows에서만 사용할 수 있습니다");
  if (candidate.available === false) throw new Error(`선택한 한컴 버전을 사용할 수 없습니다: ${candidate.unavailableReason ?? "사용할 수 없음"}`);
  if (!candidate.clsid) throw new Error("선택한 한컴 설치에는 유효한 COM CLSID가 없습니다");
  if (!path.isAbsolute(source) || !path.isAbsolute(target)) throw new Error("한컴 변환 경로는 절대 경로여야 합니다");
  await access(source);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hwp2x-hancom-"));
  const tempOutput = path.join(tempDir, `${randomUUID()}.hwpx`);
  try {
    const invocation = buildConversionInvocation(candidate, source, tempOutput);
    await runner(invocation.file, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand(invocation.script)], { timeout: 120000, env: invocation.env });
    const info = await stat(tempOutput);
    if (!info.isFile() || info.size < 4) throw new Error("한컴 HWPX 출력이 없습니다");
    const magic = await readFile(tempOutput, { encoding: null });
    if (magic[0] !== 0x50 || magic[1] !== 0x4b) throw new Error("한컴 출력이 HWPX ZIP이 아닙니다");
    await copyFile(tempOutput, target);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
