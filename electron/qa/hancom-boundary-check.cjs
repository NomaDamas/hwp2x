#!/usr/bin/env node
// Runs the boundary tests in electron/dist/hancom.test.js, which drive the real built hancom.js session script in pwsh.
// --simulation only: real Windows Hancom coexistence is NOT verified here.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

if (!process.argv.includes("--simulation")) {
  console.error("사용법: node electron/qa/hancom-boundary-check.cjs --simulation (실제 Windows 한컴 검사는 지원하지 않음)");
  process.exit(2);
}
const root = path.join(__dirname, "..");
const built = path.join(root, "dist", "hancom.js");
const tests = path.join(root, "dist", "hancom.test.js");
for (const [file, source] of [[built, "hancom.ts"], [tests, "hancom.test.ts"]]) {
  if (!fs.existsSync(file)) { console.error(`빌드 산출물 없음: ${file}`); process.exit(1); }
  if (fs.statSync(file).mtimeMs < fs.statSync(path.join(root, "src", source)).mtimeMs) { console.error(`빌드가 소스보다 오래됨: ${file}`); process.exit(1); }
}
if (spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status !== 0) { console.error("pwsh 없음: 모의검사를 실행할 수 없음"); process.exit(1); }

const boundaries = {
  "세션 시작 실패": /READY 전에 종료|READY 응답이 손상/,
  "세션 재사용": /두 파일을 이어 변환/,
  "유휴 종료": /유휴 시간/,
  "타임아웃 비파괴 중단": /hang 타임아웃은 비파괴 중단/,
  "대화상자 비파괴 중단": /modal 타임아웃은 비파괴 중단/,
  "회수 불확실시 차단": /회수 확인이 없으면/,
  "PID 재사용": /PID 재사용|시작 시간이 오래되면/,
  "동시 사용자 실행": /COM이 사용자 PID|이미 열린 한글|Explorer가 새로 띄운/,
  "같은 프로세스 사용자 문서": /사용자 문서가 증가/,
  "임의 승인 금지": /임의 승인 금지|암호와 버전 대화상자 억제|승인 모듈 파일이 없으면/,
};
const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", tests], { encoding: "utf8", timeout: 600000 });
const results = [...run.stdout.matchAll(/^(not ok|ok) \d+ - (.+)$/gm)].map(m => ({ ok: m[1] === "ok", name: m[2] }));
let failed = run.status !== 0;
for (const [label, pattern] of Object.entries(boundaries)) {
  const hits = results.filter(r => pattern.test(r.name));
  const ok = hits.length > 0 && hits.every(r => r.ok);
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"} ${label} (${hits.length}건)`);
}
const engineTests = path.join(root, "dist", "engine.test.js");
const flow = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=한컴 사용자 확인이 필요하면|한컴 안전 복구가 막히면", engineTests], { encoding: "utf8", timeout: 120000 });
const flowResults = [...(flow.stdout || "").matchAll(/^(not ok|ok) \d+ - (.+)$/gm)].filter(match => !match[2].includes("# SKIP"));
if (flow.status !== 0 || flowResults.length !== 2 || flowResults.some(match => match[1] !== "ok")) failed = true;
console.log(flow.stdout);
console.log("범위: 엔진 파일별 안내·다음 파일 결과는 보안 오류 주입과 실제 kordoc 출력으로 검사; 실제 COM 회수와 결합한 실측은 아님");
console.log("승인 모듈 귀속: electron/native/FilePathCheckerModule.c 및 x86/x64 DLL은 기존 파일 접근 승인 기능의 선행 자료이며 이번 비파괴 중단 수정에서 변경하지 않음. 파일 접근 승인과 암호·매크로·숨은 설명 대화상자 승인은 별개이며 실제 정책 검증은 14단계 대상");
console.log("미검증: 실제 Windows 한컴과 사용자 한글 공존(14단계 범위)");
if (failed) { console.error(run.stderr.slice(-4000)); process.exit(1); }
