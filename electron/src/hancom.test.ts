import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildConversionInvocation,
  conversionErrorMessage,
  conversionTrace,
  decodeConsoleText,
  convertWithHancom,
  closeHancomSession,
  decodeDiscoveryOutput,
  HANCOM_OPEN_FAILED,
  HANCOM_INTERACTION_REQUIRED,
  detectHancom,
  inspectHancomPath,
  parseDiscoveryOutput,
  type HancomCandidate,
  type PowerShellRunner,
  type HancomSessionSpawner,
} from "./hancom";

// What the discovery script prints: Base64 of the UTF-8 JSON (any console code page leaves it intact).
const wire = (json: string): string => Buffer.from(json, "utf8").toString("base64");

const candidate: HancomCandidate = {
  path: "C:\\Program Files\\HNC\\Hwp.exe",
  name: "한컴오피스 한글 12.0",
  version: "12.0.0.0",
  id: "HKLM:64:{11111111-1111-1111-1111-111111111111}",
  clsid: "{11111111-1111-1111-1111-111111111111}",
  progId: "HWPFrame.HwpObject.120",
  registryView: "64",
  hive: "HKLM",
  available: true,
};

test("Linux 환경에서는 한컴 검색이 빈 배열이고 PowerShell을 실행하지 않음", async () => {
  let called = false;
  const runner: PowerShellRunner = async () => { called = true; return { stdout: wire("[]") }; };
  assert.deepEqual(await detectHancom("linux", runner), []);
  assert.equal(called, false);
});

test("검색 JSON은 단일 객체와 배열을 허용하고 중복을 제거함", () => {
  const one = parseDiscoveryOutput(JSON.stringify(candidate));
  assert.equal(one.length, 1);
  const many = parseDiscoveryOutput(JSON.stringify([candidate, candidate, { ...candidate, registryView: "32" }]));
  assert.equal(many.length, 2);
});

test("손상 JSON은 알리고 불완전한 후보는 정상 후보를 막지 않는다", () => {
  assert.throws(() => parseDiscoveryOutput("{"), /invalid JSON/);
  assert.deepEqual(parseDiscoveryOutput(JSON.stringify({ path: "x", name: "x", clsid: "not-a-clsid" })), []);
  const result = parseDiscoveryOutput(JSON.stringify([null, { name: "빈 경로" }, { ...candidate, name: null, clsid: null }, candidate]));
  assert.equal(result.length, 2);
  assert.equal(result[0].available, false);
  assert.match(result[0].unavailableReason ?? "", /COM/);
  assert.equal(result[1].available, true);
});

test("한글 2004는 COM 등록과 관계없이 HWPX 미지원 사유를 안내한다", () => {
  const old = parseDiscoveryOutput(JSON.stringify({ ...candidate, name: "한글 2004" }))[0];
  assert.equal(old.available, false);
  assert.match(old.unavailableReason ?? "", /2004.*HWPX.*지원하지/);
  assert.match(old.unavailableReason ?? "", /kordoc/);
});

test("실제 감지처럼 이름에 제품 버전 번호만 있는 구버전도 HWPX 미지원으로 판정한다", () => {
  // The discovery script names candidates from the file version ("한컴오피스 한글 6.5.0.1000"), never "2004".
  const fromVersion = (version: string) => parseDiscoveryOutput(JSON.stringify({ ...candidate, name: `한컴오피스 한글 ${version}`, version }))[0];
  for (const version of ["6.5.0.1000", "6.0.0.0", "7.0.1.0", "7.5.0.0"]) {
    const old = fromVersion(version);
    assert.equal(old.available, false, version);
    assert.match(old.unavailableReason ?? "", /HWPX.*지원하지/, version);
  }
  for (const version of ["8.0.0.0", "9.1.1.5000", "12.0.0.1", "13.0.0.0"]) assert.equal(fromVersion(version).available, true, version);
});

test("직접 선택한 구버전 Hwp.exe는 예외 없이 지원하지 않음 사유를 돌려준다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hwp2x-pick-legacy-"));
  const exe = path.join(dir, "Hwp.exe");
  try {
    await writeFile(exe, "MZ");
    const stdout = wire(JSON.stringify([{ ...candidate, path: exe, name: "한컴오피스 한글 6.5.0.1000", version: "6.5.0.1000" }, { path: "C:\\Other\\Hwp.exe", name: null, clsid: null, available: null }]));
    const result = await inspectHancomPath(exe, "win32", async () => ({ stdout }));
    assert.equal(result.path, exe);
    assert.equal(result.available, false);
    assert.match(result.unavailableReason ?? "", /HWPX.*지원하지/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("직접 선택은 자동 감지 JSON이 깨져도 선택 경로와 조치 안내를 반환한다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hwp2x-pick-error-"));
  const exe = path.join(dir, "Hwp.exe");
  try {
    await writeFile(exe, "MZ");
    const result = await inspectHancomPath(exe, "win32", async () => ({ stdout: "{" }));
    assert.equal(result.path, exe);
    assert.equal(result.available, false);
    assert.match(result.unavailableReason ?? "", /설치 복구/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("검색 결과의 unavailable 사유를 보존함", () => {
  const unavailable = parseDiscoveryOutput(JSON.stringify({ ...candidate, available: false, unavailableReason: "no COM registration" }))[0];
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.unavailableReason, "no COM registration");
});

test("선택한 후보의 CLSID와 비트수가 변환 호출에 결합됨", () => {
  const selected = { ...candidate, registryView: "32" as const };
  const invocation = buildConversionInvocation(selected, "C:\\in.hwp", "C:\\tmp\\out.hwpx");
  assert.equal(invocation.env.HWP2X_CLSID, selected.clsid);
  assert.equal(invocation.env.HWP2X_EXE, selected.path);
  assert.match(invocation.file, /SysWOW64[\\/]WindowsPowerShell/);
  assert.match(invocation.script, /GetTypeFromCLSID/);
  assert.doesNotMatch(invocation.script, /New-Object -ComObject/);
});

test("Windows 검색 실패와 잘못된 JSON은 빈 설치로 숨기지 않음", async () => {
  await assert.rejects(
    () => detectHancom("win32", async () => { throw new Error("registry unavailable"); }),
    /Hancom discovery failed: registry unavailable/,
  );
  await assert.rejects(
    () => detectHancom("win32", async () => ({ stdout: "not-json" })),
    /invalid JSON/,
  );
});

test("Linux 변환은 거부하고 unavailable 후보도 거부함", async () => {
  await assert.rejects(() => convertWithHancom(candidate, "/tmp/in.hwp", "/tmp/out.hwpx", "linux"), /Windows에서만/);
  await assert.rejects(() => convertWithHancom({ ...candidate, available: false, unavailableReason: "no COM registration" }, "C:\\in.hwp", "C:\\out.hwpx", "win32"), /no COM registration/);
});

test("변환 실패 뒤 해당 호출의 임시 디렉터리를 정리하고 다음 변환에서 한글을 새로 띄운다", async () => {
  const session = sessionStandIn(launchOurs, { OPEN_FAIL: "broken" });
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "hwp2x-test-"));
  try {
    const convert = (name: string, content: string) => writeFile(path.join(sourceDir, `${name}.hwp`), content).then(() => convertWithHancom(session.candidate, path.join(sourceDir, `${name}.hwp`), path.join(sourceDir, `${name}.hwpx`), "win32", session.options));
    await convert("good1", "source");
    await assert.rejects(() => convert("bad", "broken"), error => (error as Error).message === HANCOM_OPEN_FAILED);
    const failedCopy = session.read().opened.at(-1)!;
    await assert.rejects(() => stat(path.dirname(failedCopy)), { code: "ENOENT" }, "실패한 호출의 임시 폴더 정리");
    await assert.rejects(() => stat(path.join(sourceDir, "bad.hwpx")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(sourceDir, "bad.hwp"), "utf8"), "broken");
    await session.exited(0);
    assert.equal(session.read().quits, 1, "실패한 세션의 한글은 닫힘");
    await convert("good2", "source");
    assert.equal(session.read().creates, 2, "실패 뒤 새 세션에서 한글을 다시 띄움");
    assert.equal((await readFile(path.join(sourceDir, "good2.hwpx"))).subarray(0, 2).toString(), "PK");
  } finally { await session.dispose(); await rm(sourceDir, { recursive: true, force: true }); }
});

test("한글에는 원본 경로를 주지 않고 읽기 전용 복사본만 열게 하며, 한글이 무엇을 해도 원본은 그대로다", async () => {
  const session = sessionStandIn(launchOurs, { OPEN_WRITE: "1" });
  const dir = await mkdtemp(path.join(os.tmpdir(), "hwp2x-readonly-"));
  try {
    const source = path.join(dir, "원본 문서.hwp");
    const target = path.join(dir, "원본 문서.hwpx");
    const original = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]);
    await writeFile(source, original);
    await convertWithHancom(session.candidate, source, target, "win32", session.options);
    const [given, ...rest] = session.read().opened;
    assert.ok(given);
    assert.notEqual(given, source, "한글은 원본 경로를 받지 않음");
    assert.equal(path.extname(given), ".hwp", "형식 인식을 위해 확장자는 유지");
    if (process.getuid?.() !== 0) assert.deepEqual(rest, [], "복사본도 읽기 전용(한글의 덮어쓰기 실패)");
    assert.deepEqual(await readFile(source), original, "원본 바이트 그대로");
    await assert.rejects(stat(path.dirname(given)), { code: "ENOENT" }, "읽기 전용 복사본까지 정리");
  } finally { await session.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("여러 파일을 동시에 넘겨도 한 세션에 한 번에 하나씩만 보내고 한글은 한 번만 띄운다", async () => {
  const session = sessionStandIn(launchOurs);
  const dir = await mkdtemp(path.join(os.tmpdir(), "hwp2x-serial-"));
  try {
    const jobs = Array.from({ length: 4 }, async (_, i) => {
      const source = path.join(dir, `${i}.hwp`);
      await writeFile(source, "source");
      await convertWithHancom(session.candidate, source, path.join(dir, `${i}.hwpx`), "win32", session.options);
    });
    // One failing file must not block or break the next ones.
    const failing = convertWithHancom(session.candidate, path.join(dir, "missing.hwp"), path.join(dir, "missing.hwpx"), "win32", session.options);
    await Promise.all([...jobs, assert.rejects(failing)]);
    assert.equal(session.maxInFlight(), 1, "응답 전 다음 작업을 보내지 않음");
    const state = session.read();
    assert.equal(state.creates, 1);
    assert.equal(state.calls.filter(call => call === "open").length, 4);
    assert.equal(state.quits, 0, "세션 유지 중에는 한글을 닫지 않음");
    for (let i = 0; i < 4; i += 1) assert.equal((await readFile(path.join(dir, `${i}.hwpx`))).subarray(0, 2).toString(), "PK");
  } finally { await session.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("짧은 유휴 시간이 지나면 세션이 변환용 한글을 닫는다", async () => {
  const session = sessionStandIn(launchOurs, {}, { idleMs: 50 });
  const dir = await mkdtemp(path.join(os.tmpdir(), "hwp2x-idle-"));
  try {
    await writeFile(path.join(dir, "a.hwp"), "source");
    await convertWithHancom(session.candidate, path.join(dir, "a.hwp"), path.join(dir, "a.hwpx"), "win32", session.options);
    await session.exited(0);
    assert.equal(session.read().quits, 1);
    assert.deepEqual(session.read().clears, ["clear 1"]);
  } finally { await session.dispose(); await rm(dir, { recursive: true, force: true }); }
});

for (const [label, script, pattern] of [
  ["READY 응답이 손상되면", "[Console]::Out.WriteLine('HWP2X_READY:@@@'); [Console]::Out.Flush(); [void][Console]::In.ReadToEnd()", /해석하지 못했습니다/],
  ["세션이 READY 전에 종료되면", `[Console]::Error.WriteLine('HWP2X_ERROR:${wire("세션 시작 실패")}'); exit 3`, /세션 시작 실패/],
] as const) {
  test(`${label} 변환을 실패로 알리고 프로세스를 남기지 않는다`, async () => {
    const children: ChildProcessWithoutNullStreams[] = [];
    const options = { timeoutMs: 1500, stopMs: 200, spawn: ((_file, _args, { env }) => { const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], { env }); children.push(child); return child; }) as HancomSessionSpawner };
    const dir = await mkdtemp(path.join(os.tmpdir(), "hwp2x-broken-"));
    try {
      await writeFile(path.join(dir, "a.hwp"), "source");
      await assert.rejects(() => convertWithHancom(candidate, path.join(dir, "a.hwp"), path.join(dir, "a.hwpx"), "win32", options), pattern);
      assert.equal(children.length, 1);
      assert.notEqual(children[0]!.exitCode ?? children[0]!.signalCode, null, "세션 프로세스 종료");
      await assert.rejects(() => stat(path.join(dir, "a.hwpx")), { code: "ENOENT" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("사용자 로그의 CP949 CLIXML 오류는 명령 덤프 없이 읽을 수 있는 한국어 한 줄이 된다", () => {
  const korean = "한컴 COM 인스턴스를 식별하지 못했습니다";
  const cp949 = Buffer.from(execFileSync("iconv", ["-f", "UTF-8", "-t", "CP949"], { input: korean }));
  const clixml = Buffer.concat([
    Buffer.from('#< CLIXML\r\n<Objs Version="1.1.0.1"><Obj S="progress" RefId="0"><MS><PR N="Record"><AV>x</AV></PR></MS></Obj><S S="Error">'),
    cp949, Buffer.from('_x000D__x000A_</S><S S="Error">+ if ($newPid.Count -ne 1) { throw ... }_x000D__x000A_</S></Objs>'),
  ]);
  // What the runner hands over: bytes decoded as CP949, not as UTF-8 (which gave the user's "     COM  ν  Ͻ").
  const stderr = decodeConsoleText(clixml);
  const error = Object.assign(new Error(`Command failed: C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -EncodedCommand CgAkAEUA\n${stderr}`), { stderr, code: 1 });
  const message = conversionErrorMessage(error);
  assert.equal(message, korean);
  assert.doesNotMatch(message, /EncodedCommand|CLIXML|\uFFFD/);
  // Old path: the same bytes read as UTF-8 are garbage, and must never reach the screen.
  const garbled = clixml.toString("utf8");
  assert.equal(conversionErrorMessage(Object.assign(new Error(`Command failed: x -EncodedCommand AAA\n${garbled}`), { stderr: garbled })), "한컴 변환에 실패했습니다");
  assert.equal(decodeConsoleText(Buffer.from("plain utf-8 한글")), "plain utf-8 한글");
});

test("HWP2X_FAKE_HANCOM 환경변수가 없으면 fake 후보를 사용하지 않음", async () => {
  const previous = process.env.HWP2X_FAKE_HANCOM;
  try {
    delete process.env.HWP2X_FAKE_HANCOM;
    assert.deepEqual(await detectHancom("linux"), []);
  } finally {
    if (previous !== undefined) process.env.HWP2X_FAKE_HANCOM = previous;
  }
});

test("PS 레지스트리 기본값과 명령 경로 파서를 실제 실행함", async () => {
  let script = "";
  await detectHancom("win32", async (_file, args) => {
    script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
    return { stdout: wire("[]") };
  });
  const functions = script.slice(script.indexOf("function Get-RegistryDefault"), script.indexOf("$result ="));
  assert.ok(functions.length > 0, "검증 가능한 레지스트리 읽기 함수 필요");
  const check = functions + String.raw`
$fake = [pscustomobject]@{}
$fake | Add-Member ScriptMethod OpenSubKey { param($name) if ($name -ne 'CLSID') { throw 'wrong key' }; $child = [pscustomobject]@{}; $child | Add-Member ScriptMethod GetValue { param($name) if ($name -ne '') { throw 'not default' }; return '{11111111-1111-1111-1111-111111111111}' }; $child | Add-Member ScriptMethod Dispose {}; return $child }
if ((Get-RegistryDefault $fake 'CLSID') -ne '{11111111-1111-1111-1111-111111111111}') { throw 'CLSID failed' }
$env:HWP_TEST_ROOT = 'C:\Program Files\HNC'
$commands = @('"C:\Program Files\HNC\Hwp.exe" /Automation', 'C:\Program Files\HNC\Hwp.exe /Automation', '"%HWP_TEST_ROOT%\Hwp.exe",0')
foreach ($command in $commands) { if ((Get-ServerPath $command) -ne 'C:\Program Files\HNC\Hwp.exe') { throw "parse failed: $command" } }
if (Get-ServerPath 'not an exe') { throw 'invalid accepted' }
'ok'
`;
  assert.match(execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(check, "utf16le").toString("base64")], { encoding: "utf8" }), /ok/);
});

test("두 PowerShell 스크립트가 문법 파서를 통과함", async () => {
  const scripts = [buildConversionInvocation(candidate, "C:\\in.hwp", "C:\\out.hwpx").script];
  await detectHancom("win32", async (_file, args) => { scripts.push(Buffer.from(args.at(-1)!, "base64").toString("utf16le")); return { stdout: wire("[]") }; });
  for (const script of scripts) {
    execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($env:SCRIPT,[ref]$t,[ref]$e);if($e.Count){$e|Out-String|Write-Error;exit 1}"], { env: { ...process.env, SCRIPT: script } });
  }
});

test("직접 선택은 파일 검증 후 COM 등록 후보만 사용 가능으로 반환함", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hwp2x-inspect-"));
  try {
    const exe = path.join(dir, "Hwp.exe");
    await writeFile(exe, "MZ");
    const runner: PowerShellRunner = async () => ({ stdout: wire(JSON.stringify({ ...candidate, path: exe.toUpperCase().replaceAll("/", "\\") })) });
    assert.equal((await inspectHancomPath(exe, "win32", runner)).clsid, candidate.clsid);
    assert.equal((await inspectHancomPath(exe, "win32", async () => ({ stdout: wire("[]") }))).available, false);
    await assert.rejects(() => inspectHancomPath("Hwp.exe", "win32", runner), /절대 경로/);
    await assert.rejects(() => inspectHancomPath(path.join(dir, "missing", "Hwp.exe"), "win32", runner), /파일/);
    await mkdir(path.join(dir, "directory"));
    await assert.rejects(() => inspectHancomPath(path.join(dir, "directory"), "win32", runner));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("레지스트리 등록이 없어도 여러 버전·비표준 설치 폴더의 Hwp.exe를 파일 검색으로 찾는다", async () => {
  let script = "";
  await detectHancom("win32", async (_file, args) => { script = Buffer.from(args.at(-1)!, "base64").toString("utf16le"); return { stdout: wire("[]") }; });
  const root = await mkdtemp(path.join(os.tmpdir(), "hwp2x-layout-"));
  try {
    // Default per-version folders on C:, a custom D:\Hnc install, a C:\Hancom install, and an unrelated Hwp.exe that must be ignored.
    const installs = [
      "C/Program Files (x86)/HNC/Office 2018/HOffice100/Bin/Hwp.exe",
      "C/Program Files (x86)/HNC/Office 2020/HOffice110/Bin/Hwp.exe",
      "C/Program Files/HNC/Office 2022/HOffice120/Bin/Hwp.exe",
      "C/Program Files/Hnc/Office 2024/HOffice130/Bin/Hwp.exe",
      "D/Hnc/Office NEO/HOffice100/Bin/Hwp.exe",
      "C/Hancom/HOffice130/Bin/Hwp.exe",
    ];
    for (const file of [...installs, "C/Games/Hwp.exe"]) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), "MZ"); }
    // Run the real discovery script; only the registry (absent) and the drive list are replaced by Linux stand-ins.
    const body = script
      .replace("[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)", "[pscustomobject]@{} | Add-Member -PassThru ScriptMethod OpenSubKey { $null } | Add-Member -PassThru ScriptMethod Dispose {}")
      .replace("[IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady }", "@('C','D') | ForEach-Object { [pscustomobject]@{ RootDirectory = [IO.DirectoryInfo](Join-Path $env:LAYOUT $_) } }")
      .replace("foreach ($root in @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'), [Environment]::GetEnvironmentVariable('ProgramW6432'))) { if ($root) { $roots.Add($root) } }", "")
      .replace("[Diagnostics.FileVersionInfo]::GetVersionInfo($full)", "[pscustomobject]@{ ProductVersion = ''; FileVersion = '' }");
    assert.notEqual(body, script, "치환 대상이 스크립트에 있어야 함");
    const out = execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", body], { encoding: "utf8", env: { ...process.env, LAYOUT: root } });
    // The real script output is Base64 of UTF-8 JSON; decode it the way the app does.
    const detected = parseDiscoveryOutput(decodeDiscoveryOutput(out));
    const found = detected.map(item => path.relative(root, item.path).replaceAll("\\", "/")).sort();
    assert.deepEqual(found, [...installs].sort());
    assert.ok(detected.every(item => item.available === false && /COM 등록/.test(item.unavailableReason ?? "")), "레지스트리 미등록은 사용 불가와 사유");
  } finally { await rm(root, { recursive: true, force: true }); }
});


// Runs the real discovery script in pwsh with its console output forced to CP949 (what Korean Windows
// PowerShell 5.1 uses), captures the raw bytes, and decodes them the way runPowerShell does (UTF-8).
// File-version lookup is replaced so the detected name is "한컴오피스 한글 13.0.0.3380", as on the user's PC.
async function detectThroughCp949Console(): Promise<{ stdout: string; candidates: HancomCandidate[] }> {
  let script = "";
  await detectHancom("win32", async (_file, args) => { script = Buffer.from(args.at(-1)!, "base64").toString("utf16le"); return { stdout: wire("[]") }; });
  const root = await mkdtemp(path.join(os.tmpdir(), "hwp2x-cp949-"));
  try {
    const exe = path.join(root, "C", "Program Files (x86)", "Hnc", "Office 2024", "HOffice130", "Bin", "Hwp.exe");
    await mkdir(path.dirname(exe), { recursive: true });
    await writeFile(exe, "MZ");
    // Same Linux stand-ins as the layout test above (no registry, a fake C: drive); only the version is set.
    const body = "[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(949)\n" + script
      .replace("[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)", "[pscustomobject]@{} | Add-Member -PassThru ScriptMethod OpenSubKey { $null } | Add-Member -PassThru ScriptMethod Dispose {}")
      .replace("[IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady }", "@('C') | ForEach-Object { [pscustomobject]@{ RootDirectory = [IO.DirectoryInfo](Join-Path $env:LAYOUT $_) } }")
      .replace("foreach ($root in @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'), [Environment]::GetEnvironmentVariable('ProgramW6432'))) { if ($root) { $roots.Add($root) } }", "")
      .replace("[Diagnostics.FileVersionInfo]::GetVersionInfo($full)", "[pscustomobject]@{ ProductVersion = '13.0.0.3380'; FileVersion = '' }");
    const raw = execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", body], { env: { ...process.env, LAYOUT: root } });
    const stdout = raw.toString("utf8");
    return { stdout, candidates: await detectHancom("win32", async () => ({ stdout })) };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("감지 결과가 UTF-8·CP949·BOM·이미 깨진 글자 어느 형태로 와도 '한컴오피스 한글 13.0.0.3380'으로 표시된다", () => {
  const name = "한컴오피스 한글 13.0.0.3380";
  const json = (n: string) => JSON.stringify([{ path: "C:\\Program Files (x86)\\Hnc\\Office 2024\\HOffice130\\Bin\\Hwp.exe", name: n, version: "13.0.0.3380", clsid: "{2291CF00-64A1-4877-A9B4-68CFE89612D6}", available: true }]);
  const cp949 = Buffer.from(execFileSync("iconv", ["-f", "UTF-8", "-t", "CP949"], { input: json(name) }));
  const cases: Record<string, string> = {
    "UTF-8 Base64 (현재 감지 스크립트)": decodeDiscoveryOutput(wire(json(name))),
    "UTF-8 + BOM": "\uFEFF" + json(name),
    "CP949 바이트를 콘솔 코드페이지대로 읽음": decodeConsoleText(cp949),
    // The user's screen: CP949 bytes read as UTF-8 — exactly "���Ŀ��ǽ� �ѱ� 13.0.0.3380".
    "CP949 바이트를 UTF-8로 잘못 읽음(사용자 화면)": cp949.toString("utf8"),
  };
  assert.match(cases["CP949 바이트를 UTF-8로 잘못 읽음(사용자 화면)"]!, /\uFFFD\uFFFD\uFFFDĿ\uFFFD\uFFFDǽ\uFFFD \uFFFDѱ\uFFFD 13\.0\.0\.3380/);
  for (const [label, text] of Object.entries(cases)) {
    const [found] = parseDiscoveryOutput(text);
    assert.equal(found?.name, name, label);
    assert.equal(found?.available, true, label);
  }
});

test("한국어 Windows(CP949 콘솔)에서도 감지된 한컴 이름이 '한컴오피스 한글 13.0.0.3380' 그대로 나온다", async () => {
  const { candidates } = await detectThroughCp949Console();
  const names = candidates.map(item => item.name);
  assert.deepEqual(names, ["한컴오피스 한글 13.0.0.3380"]);
  assert.ok(names.every(name => !/[\uFFFD?]/.test(name)), `깨진 글자 없음: ${names.join(", ")}`);
});

test("한컴 변환 실패 메시지는 CP949 콘솔에서도 한국어로 읽힌다", () => {
  // The real conversion script, made to fail with a Korean message right where it checks its input,
  // run with a CP949 console; stderr is read as UTF-8 bytes like execFile does.
  const { script } = buildConversionInvocation(candidate, "C:\\in.hwp", "C:\\out.hwpx");
  const failing = script.replace("if (!$clsid) { throw 'Invalid COM candidate' }", "if ($true) { throw '한컴 문서 열기에 실패했습니다' }");
  assert.notEqual(failing, script, "실패 지점이 스크립트에 있어야 함");
  let stderr = "";
  try {
    execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(949)\n" + failing], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HWP2X_CLSID: candidate.clsid } });
  } catch (error) {
    if (error && typeof error === "object" && "stderr" in error && Buffer.isBuffer(error.stderr)) stderr = error.stderr.toString("utf8");
  }
  assert.ok(stderr, "변환 스크립트가 실패를 알려야 함");
  assert.equal(conversionErrorMessage({ stderr }), "한컴 문서 열기에 실패했습니다");
});


// Runs the real conversion script in pwsh with Windows-only calls replaced by stand-ins: the process list
// comes from a JSON file the fake COM object updates when it "starts" Hwp.exe, like DCOM does.
type ScenarioProcess = { ProcessId: number; ParentProcessId: number; CreationDate: string; ExecutablePath: string };
type Scenario = { existing: ScenarioProcess[]; launched: ScenarioProcess[]; parents: Record<string, string>; comProcessId?: number; windowHandle?: number; windowCount?: number; msgboxThrow?: boolean; register?: "false" | "throw"; openOk?: (format: string, arg: string) => boolean; hwpMachine?: number; module?: "present" | "missing" };
function standIn(scenario: Scenario) {
  const dir = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
  const source = path.join(dir, "in.hwp"), out = path.join(dir, "out.hwpx"), procs = path.join(dir, "procs.json"), quit = path.join(dir, "quit.txt"), created = path.join(dir, "created.txt"), calls = path.join(dir, "calls.txt"), reg = path.join(dir, "reg.txt");
  execFileSync("sh", ["-c", `printf src > '${source}'`]);
  const exePath = path.join(dir, "Hwp.exe");
  execFileSync("sh", ["-c", `printf '%s' '${JSON.stringify(scenario.existing).replaceAll("HWP_EXE", exePath.replaceAll("\\", "\\\\"))}' > '${procs}'`]);
  // A stand-in Hwp.exe whose PE header says 32-bit (0x14c) or 64-bit (0x8664), and the approval modules.
  const exe = path.join(dir, "Hwp.exe");
  const pe = Buffer.alloc(0x90); pe.writeInt32LE(0x80, 0x3c); pe.write("PE\0\0", 0x80, "latin1"); pe.writeUInt16LE(scenario.hwpMachine ?? 0x14c, 0x84);
  execFileSync("sh", ["-c", `cat > '${exe}'`], { input: pe });
  for (const arch of ["x86", "x64"]) { execFileSync("mkdir", ["-p", path.join(dir, "mod", arch)]); if (scenario.module !== "missing") execFileSync("sh", ["-c", `printf MZ > '${path.join(dir, "mod", arch, "FilePathCheckerModule.dll")}'`]); }
  const { script, env: invocation } = buildConversionInvocation({ ...candidate, path: exe }, source, out, path.join(dir, "mod", "{arch}", "FilePathCheckerModule.dll"));
  const log = (name: string) => `Add-Content -LiteralPath $env:CALLS -Value "${name}"${name === "msgbox" && scenario.msgboxThrow ? "; throw 'message mode failed'" : ""}`;
  const windows = `$items = @(for ($i = 0; $i -lt [int]$env:WINDOW_COUNT; $i++) { [pscustomobject]@{ Index = $i; WindowHandle = [long]$env:WINDOW_HANDLE } | Add-Member -PassThru ScriptProperty Visible { $true } { param($value) Add-Content -LiteralPath $env:CALLS -Value "visible $($this.Index) $value" } }); $windows = [pscustomobject]@{ Count = $items.Count; Windows = $items } | Add-Member -PassThru ScriptMethod Item { param($index) $this.Windows[$index] }`;
  const body = script
    .replace("Add-Type -TypeDefinition $env:HWP2X_GUARD_SOURCE", `Add-Type -TypeDefinition 'public class Hwp2xGuard { public bool Interrupted; public bool Abandoned; public Hwp2xGuard(int id, long created, string exe) {} public void Start() {} public void Arm(int ms) {} public void Disarm() {} public void Abandon() { Abandoned = true; System.Console.WriteLine("HWP2X_GUARD:ABANDONED"); } public bool Stop() { System.Console.WriteLine("HWP2X_GUARD:RECLAIMED"); return true; } }'`)
    .replace("[Type]::GetTypeFromCLSID($clsid, $true)", "$null")
    .replace("[Activator]::CreateInstance($type)", `& { Add-Content -LiteralPath $env:CREATED -Value 'create'; Set-Content -LiteralPath $env:PROCS -Value ((@(Get-Content -Raw $env:PROCS | ConvertFrom-Json) + @(($env:LAUNCHED -replace 'LAUNCH_TIME', (Get-Date).ToString('o')) | ConvertFrom-Json)) | ConvertTo-Json -Depth 3 -AsArray); ${windows}; [pscustomobject]@{ XHwpWindows = $windows } | Add-Member -PassThru ScriptMethod Open { param($p, $f, $a) ${log("open")}; if ($env:OPENED) { Add-Content -LiteralPath $env:OPENED -Value $p; if ($env:OPEN_WRITE) { try { [IO.File]::WriteAllText($p, 'overwritten by Hwp.exe'); Add-Content -LiteralPath $env:OPENED -Value 'wrote' } catch {} }; if ($env:OPEN_FAIL -and (Get-Content -Raw -LiteralPath $p) -eq $env:OPEN_FAIL) { return $false } }; ($env:OPEN_OK -split '\\|') -contains "$f/$a" } | Add-Member -PassThru ScriptMethod SaveAs { param($p) ${log("save")}; [IO.File]::WriteAllBytes($p, [byte[]](0x50,0x4b,3,4)); $true } | Add-Member -PassThru ScriptMethod Clear { param($option) Add-Content -LiteralPath $env:CLEARS -Value "clear $option" } | Add-Member -PassThru ScriptMethod Quit { Add-Content -LiteralPath $env:QUIT -Value 'quit'; Set-Content -LiteralPath $env:PROCS -Value (@(Get-Content -Raw $env:PROCS | ConvertFrom-Json | Where-Object { $_.ProcessId -ne [int]$env:COM_PROCESS_ID }) | ConvertTo-Json -Depth 3 -AsArray) } | Add-Member -PassThru ScriptMethod RegisterModule { param($t, $d) ${log("register $t $d")}; if ($env:REGISTER -eq 'throw') { throw 'register failed' }; $env:REGISTER -ne 'false' } | Add-Member -PassThru ScriptMethod SetMessageBoxMode { param($m) ${log("msgbox")}; 0 } }`)
    .replace(`Get-CimInstance Win32_Process -Filter "Name = 'Hwp.exe'"`, "(Get-Content -Raw $env:PROCS | ConvertFrom-Json)")
    .replace(`(Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Parent)" -ErrorAction SilentlyContinue).Name`, "($env:PARENTS | ConvertFrom-Json).\"$($_.Parent)\"")
    .replace(/Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class Hwp2xWindow .*'/, "# user32 is unavailable on Linux")
    .replace("[void][Hwp2xWindow]::GetWindowThreadProcessId($handle, [ref]$comProcessId)", "$comProcessId = [uint32]$env:COM_PROCESS_ID")
    .replace("[Runtime.InteropServices.Marshal]::FinalReleaseComObject($hwp)", "$null")
    .replaceAll("$hwp.XHwpDocuments.Count", "0")
    // The registry (Windows only) becomes a file: what the script would write under HKCU.
    .replace("if (!(Test-Path -LiteralPath $modules)) { New-Item -Path $modules -Force | Out-Null }", "")
    .replace("New-ItemProperty -LiteralPath $modules -Name 'FilePathCheckerModule' -Value $moduleDll -PropertyType String -Force | Out-Null", "Set-Content -LiteralPath $env:REG -Value \"$modules|FilePathCheckerModule|$moduleDll\"");
  assert.equal(body.includes("DllImport"), false, "user32 경계가 치환되어야 함");
  assert.equal(body.includes("[void][Hwp2xWindow]::GetWindowThreadProcessId"), false, "PID 조회 경계가 치환되어야 함");
  assert.equal((body.match(/PROCS|\$env:REG/g) ?? []).length >= 5, true, "치환 대상이 스크립트에 있어야 함");
  const attempts = [["", "forceopen:true;suspendpassword:true;versionwarning:false"], ["HWP", "forceopen:true;suspendpassword:true;versionwarning:false"]];
  const openOk = attempts.filter(([format, arg]) => (scenario.openOk ?? (() => true))(format!, arg!)).map(([format, arg]) => `${format}/${arg}`).join("|");
  const clears = path.join(dir, "clears.txt");
  const env = { ...process.env, HWP2X_CLSID: candidate.clsid, HWP2X_SOURCE: source, HWP2X_TARGET: out, HWP2X_EXE: exe, HWP2X_FILEPATH_MODULE: invocation.HWP2X_FILEPATH_MODULE, PROCS: procs, QUIT: quit, CREATED: created, CALLS: calls, REG: reg, CLEARS: clears,
    HWP2X_TIMEOUT: "30000", HWP2X_INTERACTION_REQUIRED: HANCOM_INTERACTION_REQUIRED,
    PARENTS: JSON.stringify(scenario.parents),
    LAUNCHED: JSON.stringify(scenario.launched).replaceAll("HWP_EXE", exe.replaceAll("\\", "\\\\")), OPEN_OK: openOk || "none", REGISTER: scenario.register ?? "true",
    COM_PROCESS_ID: String(scenario.comProcessId ?? scenario.launched[0]?.ProcessId ?? scenario.existing[0]?.ProcessId ?? 0), WINDOW_HANDLE: String(scenario.windowHandle ?? 1234), WINDOW_COUNT: String(scenario.windowCount ?? 1) };
  const read = (file: string) => execFileSync("sh", ["-c", `cat '${file}' 2>/dev/null || true`], { encoding: "utf8" }).trim();
  const lines = (file: string) => read(file).split("\n").filter(Boolean);
  return { body, env, dir, source, out, exe, read: () => ({ quit: read(quit), quits: lines(quit).length, creates: lines(created).length, calls: lines(calls), clears: lines(clears), registry: read(reg), dir }), cleanup: () => execFileSync("rm", ["-rf", dir]) };
}

// A long-lived session: the real conversion script in pwsh behind convertWithHancom's spawn option. Each helper has its own
// spawn function, so a session from an earlier test is never reused. Extra env drives the fake Open (OPEN_FAIL/OPEN_WRITE).
function sessionStandIn(scenario: Scenario, extra: Record<string, string> = {}, options: { idleMs?: number } = {}) {
  const stand = standIn(scenario);
  const opened = path.join(stand.dir, "opened.txt");
  const children: ChildProcessWithoutNullStreams[] = [];
  let inFlight = 0, maxInFlight = 0;
  const spawner: HancomSessionSpawner = () => {
    const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", stand.body], { env: { ...stand.env, OPENED: opened, ...extra } });
    const write = child.stdin.write.bind(child.stdin) as (chunk: string) => boolean;
    child.stdin.write = ((chunk: string) => { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); return write(chunk); }) as typeof child.stdin.write;
    child.stdout.on("data", (chunk: Buffer) => { inFlight -= (chunk.toString().match(/HWP2X_DONE:/g) ?? []).length; });
    children.push(child);
    return child;
  };
  const closed = (child: ChildProcessWithoutNullStreams) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once("close", () => resolve()));
  return {
    candidate: { ...candidate, path: stand.exe },
    options: { spawn: spawner, idleMs: options.idleMs ?? 60000, timeoutMs: 30000, stopMs: 5000 },
    maxInFlight: () => maxInFlight,
    children,
    read: () => ({ ...stand.read(), opened: execFileSync("sh", ["-c", `cat '${opened}' 2>/dev/null || true`], { encoding: "utf8" }).split("\n").filter(Boolean) }),
    /** Waits until every session process except the newest `alive` has exited. */
    exited: async (alive: number) => { await Promise.all(children.slice(0, children.length - alive).map(closed)); },
    dispose: async () => { for (const child of children) child.stdin.end(); await Promise.all(children.map(child => Promise.race([closed(child), new Promise<void>(resolve => setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000))]))); stand.cleanup(); },
  };
}

// One job on stdin then EOF: the script answers DONE (ok/error) and quits. Failures before READY have no DONE and exit non-zero.
function runConversionScript(scenario: Scenario) {
  const stand = standIn(scenario);
  try {
    let stdout: string;
    try {
      stdout = execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", stand.body], { env: stand.env, encoding: "utf8", input: wire(JSON.stringify({ source: stand.source, tempOutput: stand.out })) + "\n" });
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      assert.equal(/HWP2X_DONE:/.test(e.stdout ?? ""), false, "DONE 뒤에는 정상 종료해야 함");
      return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "", ...stand.read() };
    }
    const responses = [...stdout.matchAll(/^HWP2X_DONE:([A-Za-z0-9+/=]+)$/gm)];
    assert.equal(responses.length, 1, `작업 하나에 DONE 하나: ${stdout}`);
    const done = JSON.parse(Buffer.from(responses[0]![1]!, "base64").toString("utf8")) as { ok: boolean; error?: string };
    return { ok: done.ok === true, stdout, stderr: done.ok === true ? "" : `HWP2X_ERROR:${wire(done.error ?? "")}`, ...stand.read() };
  } finally { stand.cleanup(); }
}

test("사용자가 연 한글 창이 있어도 변환용으로 새로 띄운 한글만 찾아 변환하고 그것만 닫는다", () => {
  const exe = "HWP_EXE"; // replaced with the stand-in Hwp.exe path
  const now = "LAUNCH_TIME"; // filled in by the fake COM launch, at the moment it starts Hwp.exe
  const old = new Date(Date.now() - 600000).toISOString();
  const result = runConversionScript({
    // The user's Hangul (started by Explorer) is already open; COM then starts ours under svchost.
    existing: [{ ProcessId: 100, ParentProcessId: 10, CreationDate: old, ExecutablePath: exe }],
    launched: [{ ProcessId: 200, ParentProcessId: 20, CreationDate: now, ExecutablePath: exe }],
    parents: { "10": "explorer.exe", "20": "svchost.exe" },
  });
  assert.equal(result.ok, true, result.stderr);
  const identified = conversionTrace(result.stdout).find(step => (step as { step: string }).step === "identified") as { data: { ours: number[] } };
  assert.deepEqual(identified.data.ours, [200], "새로 뜬 한글(200)만 변환용으로 고름");
  assert.equal(result.quit, "quit", "변환용 한글은 닫음");
});

test("새 한글이 뜨지 않고 이미 열린 한글에 붙으면 그 창을 쓰지도 닫지도 않고 멈춘다", () => {
  const exe = "HWP_EXE";
  const result = runConversionScript({
    existing: [{ ProcessId: 100, ParentProcessId: 10, CreationDate: new Date(Date.now() - 600000).toISOString(), ExecutablePath: exe }],
    launched: [], parents: { "10": "explorer.exe" },
  });
  assert.equal(result.ok, false);
  assert.match(conversionErrorMessage({ stderr: result.stderr }), /이미 열려 있는 한글 창에 연결되어 변환을 멈췄습니다/);
  assert.equal(result.quit, "", "사용자 한글은 닫지 않음");
  assert.deepEqual(result.calls, [], "사용자 창 숨김·등록·열기 모두 금지");
});

const launchOurs = { existing: [], launched: [{ ProcessId: 200, ParentProcessId: 20, CreationDate: "LAUNCH_TIME", ExecutablePath: "HWP_EXE" }], parents: { "20": "svchost.exe" } };
const openSteps = (stdout: string) => conversionTrace(stdout).filter(step => (step as { step: string }).step === "open-try").map(step => (step as { data: { format: string; ok: boolean } }).data);

test("한글이 자동 형식으로 못 열면 HWP 형식으로 다시 열어 변환한다", () => {
  const result = runConversionScript({ ...launchOurs, openOk: format => format === "HWP" });
  assert.equal(result.ok, true, result.stderr);
  assert.deepEqual(openSteps(result.stdout).map(step => [step.format, step.ok]), [["", false], ["HWP", true]]);
});

test("어떤 방식으로도 못 열면 시도 내역과 파일 앞부분을 남기고 '열기 실패'로 알린다", () => {
  const result = runConversionScript({ ...launchOurs, openOk: () => false });
  assert.equal(result.ok, false);
  assert.equal(conversionErrorMessage({ stderr: result.stderr }), HANCOM_OPEN_FAILED);
  assert.equal(openSteps(result.stdout).length, 2, "대화상자를 억제하는 두 가지 방식만 시도");
  const failed = conversionTrace(result.stdout).find(step => (step as { step: string }).step === "open-failed") as { data: { size: number; head: string } };
  assert.equal(failed.data.head, "73 72 63", "파일 앞부분 기록 (src)");
  assert.equal(result.quit, "quit", "변환용 한글은 실패해도 닫음");
});

test("변환용 한글에 파일 접근 승인 모듈을 문서 열기 전에 등록해 접근 경고가 뜨지 않게 한다", () => {
  const result = runConversionScript({ ...launchOurs });
  assert.equal(result.ok, true, result.stderr);
  // Registered on our instance before any file is opened, so the first Open is already approved.
  assert.deepEqual(result.calls, ["visible 0 False", "register FilePathCheckDLL FilePathCheckerModule", "visible 0 False", "open", "save"], "문서마다 열기 전에 다시 숨김");
  assert.equal(result.quit, "quit");
  const [key, name, dll] = result.registry.split("|");
  assert.equal(key, "HKCU:\\Software\\HNC\\HwpAutomation\\Modules", "현재 사용자 영역에만 기록(관리자 권한 불필요)");
  assert.equal(name, "FilePathCheckerModule");
  assert.equal(dll, path.join(result.dir, "mod", "x86", "FilePathCheckerModule.dll"), "32비트 한글에는 32비트 모듈");
  const approve = conversionTrace(result.stdout).find(step => (step as { step: string }).step === "approve") as { data: { ok: boolean; hwp64: boolean } };
  assert.deepEqual([approve.data.ok, approve.data.hwp64], [true, false]);
});

test("64비트 한글에는 64비트 승인 모듈을 등록한다", () => {
  const result = runConversionScript({ ...launchOurs, hwpMachine: 0x8664 });
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.registry.split("|")[2], path.join(result.dir, "mod", "x64", "FilePathCheckerModule.dll"));
});

test("승인 모듈 파일이 없으면 문서를 열지 않고 변환을 중단한다", () => {
  const result = runConversionScript({ ...launchOurs, module: "missing" });
  assert.equal(result.ok, false);
  assert.match(conversionErrorMessage({ stderr: result.stderr }), /보안 모듈/);
  assert.deepEqual(result.calls, ["visible 0 False"]);
  assert.equal(result.quit, "quit");
  assert.equal(result.registry, "");
  assert.equal(result.calls.some(call => call.startsWith("register")), false);
  const approve = conversionTrace(result.stdout).find(step => (step as { step: string }).step === "approve") as { data: { ok: boolean } };
  assert.equal(approve.data.ok, false);
});

test("앱에 들어 있는 승인 모듈은 32·64비트 모두 IsAccessiblePath를 내보내고 항상 승인한다", () => {
  for (const [arch, machine] of [["x86", 0x14c], ["x64", 0x8664]] as const) {
    const dll = readFileSync(path.join(__dirname, "..", "native", arch, "FilePathCheckerModule.dll"));
    const pe = dll.readInt32LE(0x3c);
    assert.equal(dll.toString("latin1", pe, pe + 4), "PE\0\0");
    assert.equal(dll.readUInt16LE(pe + 4), machine, `${arch} 모듈 비트 수`);
    assert.ok(dll.includes(Buffer.from("IsAccessiblePath\0", "latin1")), `${arch} 모듈이 IsAccessiblePath를 내보냄`);
  }
});

test("동시에 새 한글이 떠도 COM이 사용자 PID에 연결되면 창을 변경하거나 종료하지 않는다", () => {
  const result = runConversionScript({ ...launchOurs, comProcessId: 100, existing: [{ ProcessId: 100, ParentProcessId: 10, CreationDate: new Date(Date.now() - 600000).toISOString(), ExecutablePath: "HWP_EXE" }] });
  assert.equal(result.ok, false);
  assert.match(conversionErrorMessage({ stderr: result.stderr }), /이미 열려 있는 한글 창/);
  assert.deepEqual(result.calls, []);
  assert.equal(result.quit, "");
});

test("선택한 exe와 다른 COM 프로세스는 숨기거나 종료하지 않는다", () => {
  const result = runConversionScript({ ...launchOurs, launched: [{ ...launchOurs.launched[0]!, ExecutablePath: "/another/Hwp.exe" }] });
  assert.equal(result.ok, false);
  assert.match(conversionErrorMessage({ stderr: result.stderr }), /실제로 실행된 한글이 다릅니다/);
  assert.deepEqual(result.calls, []);
  assert.equal(result.quit, "");
});

test("창 핸들이 0이면 소유권을 인정하지 않고 창과 프로세스를 보존한다", () => {
  const result = runConversionScript({ ...launchOurs, windowHandle: 0 });
  assert.equal(result.ok, false);
  assert.match(conversionErrorMessage({ stderr: result.stderr }), /소유권을 확인하지 못했습니다/);
  assert.deepEqual(result.calls, []);
  assert.equal(result.quit, "");
});

test("COM PID가 새 목록에 있어도 시작 시간이 오래되면 소유권을 인정하지 않는다", () => {
  const result = runConversionScript({ ...launchOurs, launched: [{ ...launchOurs.launched[0]!, CreationDate: new Date(Date.now() - 600000).toISOString() }] });
  assert.equal(result.ok, false);
  assert.match(conversionErrorMessage({ stderr: result.stderr }), /이미 열려 있는 한글 창/);
  assert.deepEqual(result.calls, []);
  assert.equal(result.quit, "");
});

for (const register of ["false", "throw"] as const) {
  test(`승인 모듈 등록 ${register}이면 숨김 뒤 중단하고 소유한 한글만 종료한다`, () => {
    const result = runConversionScript({ ...launchOurs, register });
    assert.equal(result.ok, false);
    assert.match(conversionErrorMessage({ stderr: result.stderr }), /보안 모듈/);
    assert.deepEqual(result.calls, ["visible 0 False", "register FilePathCheckDLL FilePathCheckerModule"]);
    assert.equal(result.quit, "quit");
    assert.deepEqual(openSteps(result.stdout), []);
  });
}

test("모든 열기 시도는 암호와 버전 대화상자 억제 옵션을 유지한다", () => {
  const result = runConversionScript({ ...launchOurs, openOk: (_format, arg) => {
    assert.equal(arg, "forceopen:true;suspendpassword:true;versionwarning:false");
    return false;
  } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.calls, ["visible 0 False", "register FilePathCheckDLL FilePathCheckerModule", "visible 0 False", "open", "open"]);
  const attempts = conversionTrace(result.stdout).filter((step): step is { step: string; data: { arg: string } } => typeof step === "object" && step !== null && "step" in step && step.step === "open-try");
  assert.deepEqual(attempts.map(step => step.data.arg), Array(2).fill("forceopen:true;suspendpassword:true;versionwarning:false"));
  assert.equal(result.quit, "quit");
});

test("Explorer가 새로 띄운 한글에 COM이 연결되어도 사용자 창을 변경하거나 종료하지 않는다", () => {
  const result = runConversionScript({ ...launchOurs, parents: { "20": "explorer.exe" } });
  assert.equal(result.ok, false);
  assert.match(conversionErrorMessage({ stderr: result.stderr }), /이미 열려 있는 한글 창/);
  assert.deepEqual(result.calls, []);
  assert.equal(result.quit, "");
});

test("시작부터 사용자 문서가 증가한 다중 창은 숨기거나 종료하지 않는다", () => {
  const result = runConversionScript({ ...launchOurs, windowCount: 2 });
  assert.equal(result.ok, false);
  assert.match(result.stdout, /HWP2X_GUARD:ABANDONED/);
  assert.deepEqual(result.calls, []);
  assert.equal(result.quit, "");
});

test("임의 승인 금지: 메시지 모드를 설정하지 않는다", () => {
  const result = runConversionScript({ ...launchOurs, msgboxThrow: true });
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.calls.includes("msgbox"), false);
  assert.doesNotMatch(buildConversionInvocation(candidate, "/in.hwp", "/out.hwpx").script, /SetMessageBoxMode|SendKeys|SendMessage/);
});

test("Quit 직전 사용자 문서가 증가하면 소유를 포기하고 Quit하지 않는다 (pwsh COM 경계)", () => {
  const stand = standIn(launchOurs);
  try {
    // Inject a document-count change only at shutdown, after the successful DONE.
    const original = "try { if ([int]0 -gt $documentCount) { $guard.Abandon() } } catch { $guard.Abandon() }";
    assert.equal(stand.body.includes(original), true);
    const body = stand.body.replace(original, "try { if ([int]1 -gt $documentCount) { $guard.Abandon() } } catch { $guard.Abandon() }");
    const stdout = execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", body], { env: stand.env, encoding: "utf8", input: wire(JSON.stringify({ source: stand.source, tempOutput: stand.out })) + "\n" });
    assert.match(stdout, /HWP2X_GUARD:ABANDONED/);
    assert.equal(stand.read().quit, "", "사용자 문서를 가진 COM 인스턴스 Quit 금지");
    assert.equal(stand.read().calls.filter(call => call === "save").length, 1);
  } finally { stand.cleanup(); }
});

test("실제 watchdog C#은 컴파일되며 PID 재사용을 막는 프로세스 핸들을 사용한다", () => {
  const invocation = buildConversionInvocation(candidate, "/in.hwp", "/out.hwpx");
  execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -TypeDefinition $env:HWP2X_GUARD_SOURCE"], { env: invocation.env });
  const guard = invocation.env.HWP2X_GUARD_SOURCE!;
  assert.match(guard, /actual != created/);
  assert.match(guard, /String.Equals\(name.ToString\(\), exe/);
  assert.doesNotMatch(guard, /TerminateProcess|0x00101001/);
  assert.match(guard, /Abandon\(\);\s+return;/);
  assert.doesNotMatch(guard, /Process.GetProcessById|SendKeys|SendMessage/);
  assert.match(guard, /if \(Abandoned\).*return/);
});

for (const mode of ["modal", "hang", "startup"] as const) {
  test(`${mode} 타임아웃은 비파괴 중단하고 다음 파일을 차단한다`, () => {
    const script = `
      const assert = require('node:assert/strict');
      const { spawn } = require('node:child_process');
      const fs = require('node:fs/promises');
      const os = require('node:os'); const path = require('node:path');
      const h = require(${JSON.stringify(path.join(__dirname, "hancom.js"))});
      (async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-abandon-'));
        let starts = 0, kills = 0, child;
        const options = { timeoutMs: 1500, stopMs: 100, spawn: () => {
          starts++;
          if (${mode === "startup"}) {
            child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 3']);
            child.kill = () => { kills++; throw new Error('kill forbidden'); };
            return child;
          }
          child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', "[Console]::Out.WriteLine('HWP2X_GUARD:OWNED'); [Console]::Out.WriteLine('HWP2X_READY:${wire(JSON.stringify({ ready: true }))}'); [void][Console]::In.ReadLine(); ${mode === "modal" ? "[Console]::Out.WriteLine('HWP2X_GUARD:INTERRUPTED');" : ""} Start-Sleep -Seconds 3"]);
          child.kill = () => { kills++; throw new Error('kill forbidden'); };
          return child;
        }};
        try {
          const source = path.join(dir, 'in.hwp'); await fs.writeFile(source, 'source');
          const target = path.join(dir, 'out.hwpx'); await fs.writeFile(target, 'existing');
          for (let i = 0; i < 2; i++) await assert.rejects(h.convertWithHancom(${JSON.stringify(candidate)}, source, target, 'win32', options), { message: h.HANCOM_RECOVERY_BLOCKED });
          assert.equal(starts, 1); assert.equal(kills, 0);
          assert.equal(child.exitCode, null, '중단 시 프로세스 보존');
          assert.equal(await fs.readFile(source, 'utf8'), 'source');
          assert.equal(await fs.readFile(target, 'utf8'), 'existing');
        } finally { await fs.rm(dir, { recursive: true, force: true }); }
      })().catch(e => { console.error(e); process.exitCode = 1; });
    `;
    execFileSync(process.execPath, ["-e", script], { timeout: 15000 });
  });
}

for (const marker of ["OWNED", "ABANDONED"]) {
  test(`${marker} 회수 확인이 없으면 사용자 프로세스를 보존하고 새 세션을 차단한다`, () => {
    const script = `
      const assert = require('node:assert/strict');
      const { spawn } = require('node:child_process');
      const fs = require('node:fs/promises');
      const os = require('node:os'); const path = require('node:path');
      const h = require(${JSON.stringify(path.join(__dirname, "hancom.js"))});
      (async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-blocked-'));
        let starts = 0;
        const options = { timeoutMs: 3000, stopMs: 100, spawn: () => {
          starts++;
          return spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', "[Console]::Out.WriteLine('HWP2X_GUARD:OWNED'); [Console]::Out.WriteLine('HWP2X_GUARD:${marker}'); exit 1"]);
        }};
        try {
          const source = path.join(dir, 'in.hwp'); await fs.writeFile(source, 'source');
          for (let i = 0; i < 2; i++) await assert.rejects(h.convertWithHancom(${JSON.stringify(candidate)}, source, path.join(dir, i + '.hwpx'), 'win32', options), { message: h.HANCOM_RECOVERY_BLOCKED });
          assert.equal(starts, 1);
        } finally { await fs.rm(dir, { recursive: true, force: true }); }
      })().catch(e => { console.error(e); process.exitCode = 1; });
    `;
    execFileSync(process.execPath, ["-e", script], { timeout: 15000 });
  });
}

test("팝업 중단 뒤 소유 프로세스 자연 종료가 확인되면 다음 파일은 새 세션으로 진행한다", () => {
  const script = `
    const assert = require('node:assert/strict');
    const { spawn } = require('node:child_process');
    const fs = require('node:fs/promises');
    const os = require('node:os'); const path = require('node:path');
    const h = require(${JSON.stringify(path.join(__dirname, "hancom.js"))});
    (async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-reclaimed-'));
      let starts = 0;
      const options = { timeoutMs: 3000, stopMs: 2000, spawn: () => {
        starts++;
        const body = starts === 1
          ? "[Console]::Out.WriteLine('HWP2X_GUARD:OWNED'); [Console]::Out.WriteLine('HWP2X_READY:${wire(JSON.stringify({ ready: true }))}'); [void][Console]::In.ReadLine(); [Console]::Out.WriteLine('HWP2X_GUARD:INTERRUPTED'); Start-Sleep -Milliseconds 100; [Console]::Out.WriteLine('HWP2X_GUARD:RECLAIMED')"
          : "[Console]::Out.WriteLine('HWP2X_READY:${wire(JSON.stringify({ ready: true }))}'); [void][Console]::In.ReadLine(); [Console]::Out.WriteLine('HWP2X_DONE:${wire(JSON.stringify({ ok: false, error: "second file reached" }))}')";
        const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', body]);
        child.kill = () => { throw new Error('kill forbidden'); };
        return child;
      }};
      try {
        const source = path.join(dir, 'in.hwp'); await fs.writeFile(source, 'source');
        const target = path.join(dir, 'out.hwpx'); await fs.writeFile(target, 'existing');
        await assert.rejects(h.convertWithHancom(${JSON.stringify(candidate)}, source, target, 'win32', options), { message: h.HANCOM_INTERACTION_REQUIRED });
        await assert.rejects(h.convertWithHancom(${JSON.stringify(candidate)}, source, target, 'win32', options), /second file reached/);
        assert.equal(starts, 2);
        assert.equal(await fs.readFile(source, 'utf8'), 'source');
        assert.equal(await fs.readFile(target, 'utf8'), 'existing');
      } finally { await fs.rm(dir, { recursive: true, force: true }); }
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `;
  execFileSync(process.execPath, ["-e", script], { timeout: 15000 });
});

// closeHancomSession is a permanent shutdown: this must stay the last test in the file.
test("두 파일을 이어 변환하면 한글은 한 번만 띄워 두 번 열고, 앱 종료 때만 한 번 닫는다", async () => {
  const session = sessionStandIn(launchOurs);
  const dir = await mkdtemp(path.join(os.tmpdir(), "hwp2x-session-"));
  try {
    for (const name of ["첫째", "둘째"]) {
      await writeFile(path.join(dir, `${name}.hwp`), "source");
      await convertWithHancom(session.candidate, path.join(dir, `${name}.hwp`), path.join(dir, `${name}.hwpx`), "win32", session.options);
      assert.equal((await readFile(path.join(dir, `${name}.hwpx`))).subarray(0, 2).toString(), "PK");
    }
    let state = session.read();
    assert.deepEqual([state.creates, state.calls.filter(call => call === "open").length, state.quits], [1, 2, 0]);
    assert.deepEqual(state.clears, ["clear 1", "clear 1"], "문서마다 저장 없이 닫음");
    assert.equal(session.children.length, 1);
    await closeHancomSession();
    await session.exited(0);
    state = session.read();
    assert.equal(state.quits, 1, "종료 때 변환용 한글만 한 번 닫음");
    await assert.rejects(() => convertWithHancom(session.candidate, path.join(dir, "첫째.hwp"), path.join(dir, "셋째.hwpx"), "win32", session.options), /앱 종료 중/);
    assert.equal(session.children.length, 1, "종료 뒤 새 세션 없음");
  } finally { await session.dispose(); await rm(dir, { recursive: true, force: true }); }
});
