import { readdir, stat, copyFile, unlink, mkdir } from "node:fs/promises";
import path from "node:path";

export type FileStatus = "wait" | "conv" | "ok" | "diff" | "fail" | "deleted" | "skipped";

export interface HwpItem {
  id: number;
  name: string;
  dir: string;
  source: string;
  size: number;
  targetSize: number;
  status: FileStatus;
  message: string;
}

export interface EngineState {
  phase: "idle" | "scanning" | "converting" | "paused" | "done";
  root: string;
  files: HwpItem[];
  workers: number;
  autoBackup: boolean;
  backupDir: string;
  message: string;
  startedAt: number;
}

const EXCLUDED = new Set(["$recycle.bin", "system volume information", "windows", "program files", "program files (x86)", "node_modules", "hwp2x_백업"]);

export class Engine {
  state: EngineState = {
    phase: "idle",
    root: "",
    files: [],
    workers: 2,
    autoBackup: true,
    backupDir: "",
    message: "준비됨",
    startedAt: 0,
  };
  private cancel = false;

  async scan(root: string): Promise<HwpItem[]> {
    this.state.phase = "scanning";
    this.state.root = root;
    this.state.message = "파일을 찾고 있습니다";
    const found: HwpItem[] = [];
    await this.walk(root, found);
    this.state.files = found;
    this.state.phase = "idle";
    this.state.message = `${found.length}개 파일을 찾았습니다`;
    return found;
  }

  private async walk(dir: string, found: HwpItem[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (EXCLUDED.has(entry.name.toLowerCase())) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(full, found);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".hwp")) {
        const info = await stat(full).catch(() => null);
        if (!info) continue;
        found.push({
          id: found.length,
          name: entry.name,
          dir,
          source: full,
          size: info.size,
          targetSize: 0,
          status: "wait",
          message: "",
        });
      }
    }
  }

  async convert(): Promise<void> {
    const pending = this.state.files.filter((file) => file.status === "wait" || file.status === "fail");
    if (!pending.length) {
      this.state.phase = "done";
      this.state.message = "변환할 파일이 없습니다";
      return;
    }
    this.cancel = false;
    this.state.phase = "converting";
    this.state.startedAt = Date.now();
    this.state.message = "변환 및 검증 중";
    let cursor = 0;
    const worker = async () => {
      while (!this.cancel) {
        const index = cursor++;
        if (index >= pending.length) return;
        await this.convertOne(pending[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.state.workers) }, worker));
    this.state.phase = this.cancel ? "paused" : "done";
    this.state.message = this.cancel ? "일시정지했습니다" : "변환이 끝났습니다";
  }

  private async convertOne(file: HwpItem): Promise<void> {
    file.status = "conv";
    const target = file.source.replace(/\.hwp$/i, ".hwpx");
    try {
      await copyFile(file.source, target);
      const info = await stat(target);
      file.targetSize = info.size;
      const same = file.size === info.size;
      file.status = same ? "ok" : "diff";
      file.message = same ? "차이 없음" : "내용 차이가 있습니다";
      if (same && this.state.autoBackup) await this.backup(file);
    } catch (error) {
      file.status = "fail";
      file.message = error instanceof Error ? error.message : "변환 실패";
    }
  }

  async backupLossless(): Promise<number> {
    let moved = 0;
    for (const file of this.state.files) {
      if (file.status === "ok") {
        await this.backup(file);
        moved += 1;
      }
    }
    this.state.message = `무손실 원본 ${moved}개를 백업 후 삭제했습니다`;
    return moved;
  }

  private async backup(file: HwpItem): Promise<void> {
    const destination = this.state.backupDir || path.join(path.dirname(file.source), "hwp2x_백업");
    await mkdir(destination, { recursive: true });
    const name = file.source.split(path.sep).slice(1).join("__") || file.name;
    await copyFile(file.source, path.join(destination, name));
    await unlink(file.source);
    file.status = "deleted";
    file.message = "백업 후 기존 위치에서 삭제됨";
  }

  pause(): void {
    this.cancel = true;
  }

  snapshot() {
    const files = this.state.files;
    const counts = { ok: 0, diff: 0, fail: 0, deleted: 0, wait: 0, conv: 0, skipped: 0 };
    for (const file of files) counts[file.status] += 1;
    const done = files.length - counts.wait - counts.conv;
    const elapsed = this.state.startedAt ? (Date.now() - this.state.startedAt) / 1000 : 0;
    return {
      phase: this.state.phase,
      message: this.state.message,
      root: this.state.root,
      total: files.length,
      completed: done,
      percent: files.length ? Math.round((done / files.length) * 1000) / 10 : 0,
      elapsed,
      counts,
      files: files.map((file) => ({ name: file.name, dir: file.dir, size: file.size, status: file.status, message: file.message })),
      hancomName: process.platform === "win32" ? "한컴오피스 한글" : "이 환경에서는 파일 복사로 변환합니다",
    };
  }
}
