import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initLogger, log, logPath, logDir, recentLog, flushLog } from "./logger";

test("로그는 초기화 전 기록과 오류를 순서대로 저장하고 실패 후 복구한다", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hwp2x-logger-"));
  try {
    log("info", "초기화 전");
    const target = await initLogger(root, { platform: "테스트" });
    assert.equal(logPath(), target);
    assert.equal(logDir(), root);
    const error = Object.assign(new Error("실패 이유"), { code: "EFAIL" });
    const circular: Record<string, unknown> = { number: 123n, absent: undefined };
    circular.self = circular;
    assert.doesNotThrow(() => log("error", "오류", { error, circular }));
    for (let i = 0; i < 20; i++) log("info", "순서", { i });
    await flushLog();
    const rows = (await fs.readFile(target, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows[0].event, "초기화 전");
    assert.equal(rows[1].event, "실행 환경");
    assert.equal(rows[2].error.message, "실패 이유");
    assert.equal(rows[2].error.code, "EFAIL");
    assert.match(rows[2].error.stack, /실패 이유/);
    assert.equal(rows[2].circular.self, "[순환 참조]");
    assert.equal(rows[2].circular.number, "123");
    assert.equal(rows[2].circular.absent, null);
    assert.deepEqual(rows.slice(3).map(row => row.i), Array.from({ length: 20 }, (_, i) => i));
    assert.ok(rows.every(row => row.t && row.level));

    await fs.writeFile(target, "x".repeat(5 * 1024 * 1024));
    log("warn", "회전 이후");
    await flushLog();
    assert.equal((await fs.stat(target + ".1")).size, 5 * 1024 * 1024);
    assert.equal(JSON.parse((await fs.readFile(target, "utf8")).trim()).event, "회전 이후");

    await fs.writeFile(target, "앞부분한글끝부분");
    assert.equal(await recentLog(9), "끝부분");
    assert.equal(await recentLog(10), "끝부분");
    assert.equal(await recentLog(0), "");
    assert.equal(await recentLog(-1), "");

    const old = path.join(root, "hwp2x-2000-01-01.log");
    await fs.writeFile(old, "old");
    await fs.writeFile(old + ".1", "old");
    await fs.writeFile(path.join(root, "문서.hwp"), "원본");
    await initLogger(root, {});
    await assert.rejects(fs.stat(old), { code: "ENOENT" });
    await assert.rejects(fs.stat(old + ".1"), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(root, "문서.hwp"), "utf8"), "원본");

    const blocked = path.join(root, "폴더가 아닌 파일");
    await fs.writeFile(blocked, "유지");
    await assert.doesNotReject(initLogger(path.join(blocked, "logs"), {}));
    assert.doesNotThrow(() => log("error", "쓰기 실패"));
    await assert.doesNotReject(flushLog());
    assert.equal(await recentLog(), "");
    await initLogger(root, {});
    log("info", "복구 완료");
    await flushLog();
    assert.match(await recentLog(), /복구 완료/);
    assert.equal(await fs.readFile(blocked, "utf8"), "유지");
  } finally {
    await flushLog();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("목록 읽기 권한이 없어도 실행 환경과 이후 기록을 저장한다", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hwp2x-permission-"));
  try {
    await fs.chmod(root, 0o300);
    await assert.rejects(fs.readdir(root), { code: "EACCES" });
    const target = await initLogger(root, { 확인: "목록 권한 없음" });
    log("info", "기록 유지");
    await flushLog();
    const rows = (await fs.readFile(target, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => row.event), ["실행 환경", "기록 유지"]);
  } finally {
    await fs.chmod(root, 0o700);
    await fs.rm(root, { recursive: true, force: true });
  }
});
