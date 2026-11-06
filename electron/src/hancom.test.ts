import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  buildConversionInvocation,
  convertWithHancom,
  detectHancom,
  inspectHancomPath,
  parseDiscoveryOutput,
  type HancomCandidate,
  type PowerShellRunner,
} from "./hancom";

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
  const runner: PowerShellRunner = async () => { called = true; return { stdout: "[]" }; };
  assert.deepEqual(await detectHancom("linux", runner), []);
  assert.equal(called, false);
});

test("검색 JSON은 단일 객체와 배열을 허용하고 중복을 제거함", () => {
  const one = parseDiscoveryOutput(JSON.stringify(candidate));
  assert.equal(one.length, 1);
  const many = parseDiscoveryOutput(JSON.stringify([candidate, candidate, { ...candidate, registryView: "32" }]));
  assert.equal(many.length, 2);
});

test("검색 JSON은 불완전하거나 잘못된 CLSID를 거부함", () => {
  assert.throws(() => parseDiscoveryOutput("{"), /invalid JSON/);
  assert.throws(() => parseDiscoveryOutput(JSON.stringify({ path: "x", name: "x", clsid: "not-a-clsid" })), /invalid candidate/);
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
  await assert.rejects(() => convertWithHancom({ ...candidate, available: false, unavailableReason: "no COM registration" }, "C:\\in.hwp", "C:\\out.hwpx", "win32", async () => ({ stdout: "" })), /no COM registration/);
});

test("변환 실패 뒤 해당 호출의 임시 디렉터리를 정리함", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "hwp2x-test-"));
  try {
    const source = path.join(sourceDir, "in.hwp");
    const target = path.join(sourceDir, "out.hwpx");
    await writeFile(source, "source");
    let temporary = "";
    const runner: PowerShellRunner = async (_file, _args, options) => {
      temporary = options.env?.HWP2X_TARGET ?? "";
      throw new Error("COM failed");
    };
    await assert.rejects(() => convertWithHancom(candidate, source, target, "win32", runner), /COM failed/);
    assert.ok(temporary, "runner must receive its temporary output path");
    await assert.rejects(() => stat(path.dirname(temporary)), { code: "ENOENT" });
    await assert.rejects(() => stat(target), { code: "ENOENT" });
    assert.equal(await readFile(source, "utf8"), "source");
  } finally { await rm(sourceDir, { recursive: true, force: true }); }
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
    return { stdout: "[]" };
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
  await detectHancom("win32", async (_file, args) => { scripts.push(Buffer.from(args.at(-1)!, "base64").toString("utf16le")); return { stdout: "[]" }; });
  for (const script of scripts) {
    execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($env:SCRIPT,[ref]$t,[ref]$e);if($e.Count){$e|Out-String|Write-Error;exit 1}"], { env: { ...process.env, SCRIPT: script } });
  }
});

test("직접 선택은 파일 검증 후 COM 등록 후보만 사용 가능으로 반환함", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hwp2x-inspect-"));
  try {
    const exe = path.join(dir, "Hwp.exe");
    await writeFile(exe, "MZ");
    const runner: PowerShellRunner = async () => ({ stdout: JSON.stringify({ ...candidate, path: exe.toUpperCase().replaceAll("/", "\\") }) });
    assert.equal((await inspectHancomPath(exe, "win32", runner)).clsid, candidate.clsid);
    assert.equal((await inspectHancomPath(exe, "win32", async () => ({ stdout: "[]" }))).available, false);
    await assert.rejects(() => inspectHancomPath("Hwp.exe", "win32", runner), /절대 경로/);
    await assert.rejects(() => inspectHancomPath(path.join(dir, "missing", "Hwp.exe"), "win32", runner), /파일/);
    await mkdir(path.join(dir, "directory"));
    await assert.rejects(() => inspectHancomPath(path.join(dir, "directory"), "win32", runner));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
