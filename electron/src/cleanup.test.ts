import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, lstat, readFile, readdir, rename, link, symlink, open } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Cleanup } from "./cleanup";
import type { HwpItem } from "./engine";
import { spawnSync } from "node:child_process";

const digest = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
async function fixture() {
  const root = path.join(tmpdir(), `cleanup-test-${randomUUID()}`);
  const backupDir = path.join(root, "backup"), journal = path.join(root, "cleanup.json");
  await mkdir(backupDir, { recursive: true });
  const source = path.join(root, "sample.hwp"), target = path.join(root, "sample.hwpx");
  const sourceData = Buffer.from("source-data"), targetData = Buffer.from("target-data");
  await writeFile(source, sourceData); await writeFile(target, targetData);
  const item: HwpItem = { id: 1, name: "sample.hwp", dir: root, source, target, size: sourceData.length, targetSize: targetData.length, status: "ok", message: "", owned: { status: "ok", sourceHash: digest(sourceData), targetHash: digest(targetData) } };
  return { root, backupDir, journal, source, target, sourceData, targetData, item };
}

describe("Cleanup", () => {
  it("검증된 원본을 백업하고 완료 후 복원한다", async () => {
    const f = await fixture();
    try {
      const cleanup = new Cleanup(f.journal);
      const promise = cleanup.start([f.item], f.backupDir);
      assert.equal(cleanup.busy, true);
      await promise;
      assert.equal(cleanup.snapshot().phase, "done"); assert.equal(cleanup.snapshot().canRollback, true);
      await assert.rejects(lstat(f.source), { code: "ENOENT" });
      assert.deepEqual(await readFile(f.target), f.targetData);
      const directory = (await readdir(f.backupDir))[0];
      assert.ok(directory); assert.deepEqual(await readFile(path.join(f.backupDir, directory, "0.hwp")), f.sourceData);
      await cleanup.rollback();
      assert.equal(cleanup.snapshot().phase, "rolledBack"); assert.deepEqual(await readFile(f.source), f.sourceData);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("재시작 시 중단된 삭제 의도를 자동 복원한다", async () => {
    const f = await fixture();
    try {
      const first = new Cleanup(f.journal); await first.start([f.item], f.backupDir);
      const second = new Cleanup(f.journal); await second.restore();
      assert.equal(second.snapshot().phase, "done"); assert.equal(second.snapshot().canRollback, true);
      await second.rollback(); assert.deepEqual(await readFile(f.source), f.sourceData);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("원본 해시 변경 시 삭제하지 않고 자동 복원한다", async () => {
    const f = await fixture();
    try {
      await writeFile(f.source, "changed");
      const cleanup = new Cleanup(f.journal); await cleanup.start([f.item], f.backupDir);
      assert.equal(cleanup.snapshot().phase, "rolledBack"); assert.deepEqual(await readFile(f.source), Buffer.from("changed"));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("복원 위치 충돌은 덮어쓰지 않고 재시도 가능 상태로 둔다", async () => {
    const f = await fixture();
    try {
      const cleanup = new Cleanup(f.journal); await cleanup.start([f.item], f.backupDir);
      await writeFile(f.source, "foreign"); await cleanup.rollback();
      assert.equal(cleanup.snapshot().phase, "error"); assert.equal(cleanup.snapshot().canRollback, true);
      assert.deepEqual(await readFile(f.source), Buffer.from("foreign"));
      await rm(f.source); await cleanup.rollback(); assert.equal(cleanup.snapshot().phase, "rolledBack");
      assert.deepEqual(await readFile(f.source), f.sourceData);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("충돌 오류 journal 저장 중에는 rollingBack이고 저장 후에만 재시도 가능하다", async t => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const savingError = new Promise<void>(resolve => { entered = resolve; });
    let rollback: Promise<void> | undefined;
    try {
      const cleanup = new Cleanup(f.journal); await cleanup.start([f.item], f.backupDir);
      assert.equal(cleanup.snapshot().phase, "done");
      await assert.rejects(lstat(f.source), { code: "ENOENT" });
      const journal = JSON.parse(await readFile(f.journal, "utf8"));
      await writeFile(f.source, "foreign");
      const fs = require("node:fs/promises") as typeof FsPromises;
      const realOpen = fs.open;
      t.mock.method(fs, "open", async (...args: Parameters<typeof realOpen>) => {
        const handle = await realOpen(...args);
        if (String(args[0]).startsWith(`${f.journal}.`) && String(args[0]).endsWith(".tmp")) {
          const realWriteFile = handle.writeFile.bind(handle);
          t.mock.method(handle, "writeFile", async (...writeArgs: Parameters<typeof realWriteFile>) => {
            if (typeof writeArgs[0] === "string" && JSON.parse(writeArgs[0]).phase === "error") {
              entered(); await gate;
            }
            return realWriteFile(...writeArgs);
          });
        }
        return handle;
      });
      rollback = cleanup.rollback();
      await Promise.race([savingError, rollback.then(() => { throw new Error("오류 journal 저장 gate에 진입하지 않음"); })]);
      assert.equal(cleanup.busy, true);
      assert.equal(cleanup.snapshot().phase, "rollingBack");
      assert.equal(cleanup.snapshot().canRollback, false);
      assert.equal(JSON.parse(await readFile(f.journal, "utf8")).phase, "rollingBack");
      release(); await rollback;
      assert.equal(cleanup.busy, false);
      assert.equal(cleanup.snapshot().phase, "error");
      assert.equal(cleanup.snapshot().canRollback, true);
      assert.match(cleanup.snapshot().message, /기존 파일 충돌/);
      assert.equal(JSON.parse(await readFile(f.journal, "utf8")).phase, "error");
      assert.equal(await readFile(f.source, "utf8"), "foreign");
      assert.deepEqual(await readFile(journal.entries[0].quarantine), f.sourceData);
      assert.deepEqual(await readFile(journal.entries[0].backup), f.sourceData);
      assert.deepEqual(await readFile(f.target), f.targetData);
    } finally { release(); await rollback; t.mock.restoreAll(); await rm(f.root, { recursive: true, force: true }); }
  });

  it("복원 완료 journal을 보관하고 다음 작업을 허용한다", async () => {
    const f = await fixture();
    try {
      const cleanup = new Cleanup(f.journal);
      for (let cycle = 0; cycle < 2; cycle++) {
        await cleanup.start([f.item], f.backupDir);
        assert.equal(cleanup.snapshot().phase, "done");
        assert.equal(cleanup.snapshot().processed, 1); assert.equal(cleanup.snapshot().percent, 100);
        await cleanup.rollback();
        assert.equal(cleanup.snapshot().phase, "rolledBack");
        assert.equal(cleanup.snapshot().processed, 1); assert.equal(cleanup.snapshot().percent, 100);
        assert.equal(cleanup.snapshot().canRollback, false);
        assert.deepEqual(await readFile(f.source), f.sourceData);
        await cleanup.rollback();
        assert.equal(cleanup.snapshot().processed, 1); assert.equal(cleanup.snapshot().percent, 100);
      }
      assert.ok((await readdir(f.root)).some(name => name.startsWith("cleanup.json.archive-")));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("대상이 없으면 journal 없이 오류이며 재시작은 idle이다", async () => {
    const f = await fixture();
    try {
      const cleanup = new Cleanup(f.journal); await cleanup.start([{ ...f.item, status: "diff" }], f.backupDir);
      assert.equal(cleanup.snapshot().phase, "error"); await assert.rejects(lstat(f.journal), { code: "ENOENT" });
      assert.equal(cleanup.snapshot().canRollback, false); assert.equal(cleanup.busy, false);
      const restarted = new Cleanup(f.journal); await restarted.restore();
      assert.equal(restarted.snapshot().phase, "idle");
      await restarted.start([f.item], f.backupDir); assert.equal(restarted.snapshot().phase, "done");
      await restarted.rollback();
      assert.deepEqual(await readFile(f.source), f.sourceData);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});

async function crashFixture() {
  const f = await fixture(), id = randomUUID();
  const directory = path.join(f.backupDir, `hwp2x-cleanup-${id}`);
  const quarantineDir = path.join(f.root, `.sample.hwp.hwp2x-cleanup-${id}-0`);
  await mkdir(directory); await mkdir(quarantineDir);
  const info = await lstat(f.source);
  const entry = { source: f.source, target: f.target, backup: path.join(directory, "0.hwp"), quarantine: path.join(quarantineDir, "original.bin"), hash: digest(f.sourceData), targetHash: digest(f.targetData), mode: info.mode & 0o777, atime: info.atimeMs, mtime: info.mtimeMs, intent: true, restored: false };
  const journal = { version: 1, id, directory, phase: "running", entries: [entry] };
  return { ...f, entry, journalData: journal };
}

describe("Cleanup 안전 복구", () => {
  it("즉시 취소하면 원본과 결과를 보존하고 재시작할 수 있다", async () => {
    const f = await fixture();
    try {
      const cleanup = new Cleanup(f.journal);
      const running = cleanup.start([f.item], f.backupDir); cleanup.cancel(); await running;
      assert.equal(cleanup.snapshot().phase, "rolledBack"); assert.equal(cleanup.busy, false);
      assert.equal(cleanup.snapshot().canRollback, false);
      assert.deepEqual(await readFile(f.source), f.sourceData); assert.deepEqual(await readFile(f.target), f.targetData);
      const restarted = new Cleanup(f.journal); await restarted.restore();
      assert.equal(restarted.snapshot().phase, "rolledBack");
      await restarted.start([f.item], f.backupDir); assert.equal(restarted.snapshot().phase, "done");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("결과가 변경되면 원본을 지우지 않고 자동 복원한다", async () => {
    const f = await fixture();
    try {
      await writeFile(f.target, "changed-output");
      const cleanup = new Cleanup(f.journal); await cleanup.start([f.item], f.backupDir);
      assert.equal(cleanup.snapshot().phase, "rolledBack"); assert.equal(cleanup.snapshot().canRollback, false);
      assert.deepEqual(await readFile(f.source), f.sourceData); assert.equal(await readFile(f.target, "utf8"), "changed-output");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  for (const field of ["source", "target", "backupDir"] as const) {
    it(`${field} symlink를 거부하고 참조 파일을 보존한다`, async () => {
      const f = await fixture();
      try {
        const destination = `${f[field]}.real`;
        await rename(f[field], destination); await symlink(destination, f[field], field === "backupDir" ? "dir" : "file");
        const cleanup = new Cleanup(f.journal); await cleanup.start([f.item], f.backupDir);
        assert.equal(cleanup.snapshot().phase, "error"); assert.equal((await lstat(f[field])).isSymbolicLink(), true);
        assert.deepEqual(await readFile(f.source), f.sourceData); assert.deepEqual(await readFile(f.target), f.targetData);
        await assert.rejects(lstat(f.journal), { code: "ENOENT" });
      } finally { await rm(f.root, { recursive: true, force: true }); }
    });
  }

  for (const quarantinePresent of [false, true]) {
    it(`백업 손상 시 격리 파일 ${quarantinePresent ? "있으면 복원" : "없으면 오류와 보존"}`, async () => {
      const f = await crashFixture();
      try {
        await rename(f.source, f.entry.quarantine);
        if (!quarantinePresent) await rm(f.entry.quarantine);
        await writeFile(f.entry.backup, "corrupt-backup");
        await writeFile(f.journal, JSON.stringify(f.journalData));
        const cleanup = new Cleanup(f.journal); await cleanup.restore();
        assert.equal(cleanup.snapshot().phase, quarantinePresent ? "rolledBack" : "error");
        if (quarantinePresent) {
          assert.deepEqual(await readFile(f.source), f.sourceData);
          assert.deepEqual(await readFile(f.entry.quarantine), f.sourceData);
        } else {
          await assert.rejects(lstat(f.source), { code: "ENOENT" }); assert.equal(cleanup.snapshot().canRollback, true);
        }
        assert.equal(await readFile(f.entry.backup, "utf8"), "corrupt-backup");
      } finally { await rm(f.root, { recursive: true, force: true }); }
    });
  }

  for (const point of ["intent-before-rename", "after-rename", "after-hardlink-before-save"] as const) {
    it(`crash ${point} 상태를 재시작 시 멱등 복원한다`, async () => {
      const f = await crashFixture();
      try {
        if (point !== "intent-before-rename") await rename(f.source, f.entry.quarantine);
        if (point === "after-hardlink-before-save") {
          await link(f.entry.quarantine, f.source); f.journalData.phase = "rollingBack";
        }
        await writeFile(f.journal, JSON.stringify(f.journalData));
        const cleanup = new Cleanup(f.journal); await cleanup.restore();
        assert.equal(cleanup.snapshot().phase, "rolledBack"); assert.equal(cleanup.snapshot().processed, 1);
        assert.equal(cleanup.snapshot().percent, 100); assert.equal(cleanup.snapshot().canRollback, false);
        assert.deepEqual(await readFile(f.source), f.sourceData);
        if (point !== "intent-before-rename") {
          assert.deepEqual(await readFile(f.entry.quarantine), f.sourceData);
          assert.equal((await lstat(f.source)).ino, (await lstat(f.entry.quarantine)).ino);
        }
        const restarted = new Cleanup(f.journal); await restarted.restore(); await restarted.rollback();
        assert.equal(restarted.snapshot().phase, "rolledBack"); assert.equal(restarted.snapshot().processed, 1);
        assert.equal(restarted.snapshot().percent, 100); assert.deepEqual(await readFile(f.source), f.sourceData);
      } finally { await rm(f.root, { recursive: true, force: true }); }
    });
  }

  it("열린 descriptor가 rename 뒤 변경한 데이터는 보존하고 rollback은 오류로 남긴다", async () => {
    const f = await fixture();
    const descriptor = await open(f.source, "r+");
    try {
      const cleanup = new Cleanup(f.journal); await cleanup.start([f.item], f.backupDir);
      assert.equal(cleanup.snapshot().phase, "done");
      const journal = JSON.parse(await readFile(f.journal, "utf8"));
      const quarantine = journal.entries[0].quarantine;
      assert.equal(path.basename(quarantine), "original.bin");
      assert.equal(path.dirname(path.dirname(quarantine)), f.root);
      await descriptor.write(Buffer.from("edited-data"), 0, 11, 0); await descriptor.sync();
      await cleanup.rollback();
      assert.equal(cleanup.snapshot().phase, "error"); assert.equal(cleanup.snapshot().canRollback, true);
      await assert.rejects(lstat(f.source), { code: "ENOENT" });
      assert.equal(await readFile(quarantine, "utf8"), "edited-data");
      assert.deepEqual(await readFile(journal.entries[0].backup), f.sourceData);
      const restarted = new Cleanup(f.journal); await restarted.restore();
      assert.equal(restarted.snapshot().phase, "error"); assert.equal(await readFile(quarantine, "utf8"), "edited-data");
    } finally { await descriptor.close(); await rm(f.root, { recursive: true, force: true }); }
  });

  for (const field of ["source", "target", "backup", "quarantine", "directory"] as const) {
    it(`journal ${field} 경로 변조를 거부하고 파일을 건드리지 않는다`, async () => {
      const f = await crashFixture();
      try {
        await rename(f.source, f.entry.quarantine);
        await writeFile(f.entry.backup, f.sourceData);
        const originalQuarantine = f.entry.quarantine;
        if (field === "directory") f.journalData.directory = `${f.backupDir}/../backup/${path.basename(f.journalData.directory)}`;
        else if (field === "source" || field === "target") f.entry[field] = `${f.root}/../${path.basename(f.root)}/${path.basename(f.entry[field])}`;
        else f.entry[field] = f.target;
        const serialized = JSON.stringify(f.journalData); await writeFile(f.journal, serialized);
        const cleanup = new Cleanup(f.journal); await cleanup.restore();
        assert.equal(cleanup.snapshot().phase, "error"); assert.equal(cleanup.snapshot().canRollback, false);
        await assert.rejects(lstat(f.source), { code: "ENOENT" });
        assert.deepEqual(await readFile(originalQuarantine), f.sourceData); assert.deepEqual(await readFile(f.target), f.targetData);
        assert.equal(await readFile(f.journal, "utf8"), serialized);
      } finally { await rm(f.root, { recursive: true, force: true }); }
    });
  }

  for (const point of ["backup-written", "intent-saved", "source-moved", "done-saved", "restore-linked"] as const) {
    it(`[실제 SIGKILL] ${point} 재시작 시 원본 바이트를 복구한다`, async () => {
      const f = await fixture();
      try {
        const script = `
          const fs = require('node:fs/promises');
          const payload = JSON.parse(process.env.CLEANUP_CRASH_PAYLOAD);
          const kill = () => process.kill(process.pid, 'SIGKILL');
          const rename = fs.rename, open = fs.open, link = fs.link;
          fs.rename = async (...args) => {
            await rename(...args);
            if (payload.point === 'source-moved' && args[0] === payload.source) kill();
            if (args[1] === payload.journal) {
              const journal = JSON.parse(await fs.readFile(payload.journal, 'utf8'));
              if (payload.point === 'intent-saved' && journal.phase === 'running' && journal.entries[0].intent) kill();
              if (payload.point === 'done-saved' && journal.phase === 'done') kill();
            }
          };
          fs.open = async (...args) => {
            const handle = await open(...args);
            if (payload.point === 'backup-written' && String(args[0]).endsWith('/0.hwp') && args[1] === 'wx') {
              const sync = handle.sync.bind(handle);
              handle.sync = async () => { await sync(); kill(); };
            }
            return handle;
          };
          fs.link = async (...args) => { await link(...args); if (payload.point === 'restore-linked' && args[1] === payload.source) kill(); };
          const { Cleanup } = require(payload.module);
          (async () => { const c = new Cleanup(payload.journal); await c.start([payload.item], payload.backupDir); await c.rollback(); process.exit(12); })().catch(e => { console.error(e); process.exit(13); });
        `;
        const child = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, CLEANUP_CRASH_PAYLOAD: JSON.stringify({ ...f, point, module: require.resolve("./cleanup") }) }, timeout: 30000 });
        assert.equal(child.signal, "SIGKILL", child.stderr?.toString());
        const restarted = new Cleanup(f.journal); await restarted.restore();
        if (restarted.snapshot().phase === "done") await restarted.rollback();
        assert.equal(restarted.snapshot().phase, "rolledBack", restarted.snapshot().message);
        assert.deepEqual(await readFile(f.source), f.sourceData); assert.deepEqual(await readFile(f.target), f.targetData);
        const again = new Cleanup(f.journal); await again.restore();
        assert.equal(again.snapshot().phase, "rolledBack"); assert.deepEqual(await readFile(f.source), f.sourceData);
      } finally { await rm(f.root, { recursive: true, force: true }); }
    });
  }

  for (const [label, op, code] of [["백업 쓰기 ENOSPC", "open", "ENOSPC"], ["백업 쓰기 거부", "open", "EACCES"], ["복구불가 매체(hardlink 불가)", "link", "EPERM"]] as const) {
    it(`[오류주입] ${label}이면 원본 이동 전에 거부하고 원본·메타데이터를 보존한다`, async t => {
      const f = await fixture();
      try {
        const before = await lstat(f.source);
        const fs = require("node:fs/promises") as typeof FsPromises;
        // node:test mock.method cannot express the union of open/link signatures.
        const real = fs[op] as unknown as (...args: unknown[]) => Promise<unknown>;
        t.mock.method(fs, op, (async (...args: unknown[]) => {
          const target = String(args[op === "link" ? 1 : 0]);
          if ((op === "link" && target.endsWith("recovery-probe")) || (op === "open" && target.endsWith(`${path.sep}0.hwp`) && args[1] === "wx")) throw Object.assign(new Error(code), { code });
          return real(...args);
        }) as unknown as typeof real);
        const cleanup = new Cleanup(f.journal); await cleanup.start([f.item], f.backupDir);
        t.mock.restoreAll();
        assert.equal(cleanup.snapshot().phase, "rolledBack"); assert.equal(cleanup.snapshot().canRollback, false);
        const after = await lstat(f.source);
        assert.deepEqual(await readFile(f.source), f.sourceData); assert.deepEqual(await readFile(f.target), f.targetData);
        assert.equal(after.ino, before.ino); assert.equal(after.mode, before.mode); assert.equal(after.mtimeMs, before.mtimeMs);
        assert.equal(JSON.parse(await readFile(f.journal, "utf8")).entries[0].intent, false);
      } finally { t.mock.restoreAll(); await rm(f.root, { recursive: true, force: true }); }
    });
  }

  it("검증된 백업이 intent 기록과 원본 이동보다 먼저 존재한다", async t => {
    const f = await fixture();
    try {
      const fs = require("node:fs/promises") as typeof FsPromises;
      const realRename = fs.rename; const seen: boolean[] = [];
      t.mock.method(fs, "rename", async (from: string, to: string) => {
        if (from === f.source) {
          const journal = JSON.parse(await readFile(f.journal, "utf8"));
          seen.push(journal.entries[0].intent, digest(await readFile(journal.entries[0].backup)) === digest(f.sourceData));
        }
        return realRename(from, to);
      });
      const cleanup = new Cleanup(f.journal); await cleanup.start([f.item], f.backupDir);
      t.mock.restoreAll();
      assert.deepEqual(seen, [true, true]); assert.equal(cleanup.snapshot().phase, "done");
      await cleanup.rollback(); assert.deepEqual(await readFile(f.source), f.sourceData);
    } finally { t.mock.restoreAll(); await rm(f.root, { recursive: true, force: true }); }
  });
});
