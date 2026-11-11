import { app } from "electron";
import { mkdir, writeFile, unlink, rename, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** The portable launcher must survive the temporary extraction directory. */
export async function setAutoLaunch(enabled: boolean): Promise<void> {
  const executable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  if (enabled) {
    if (!path.isAbsolute(executable) || /[\r\n]/.test(executable)) throw new Error("자동 실행할 프로그램의 절대 경로가 올바르지 않습니다");
    const info = await stat(executable).catch(() => null);
    if (!info?.isFile()) throw new Error("자동 실행할 프로그램을 찾을 수 없습니다. 포터블을 이동했다면 현재 위치에서 다시 설정하세요");
  }
  if (process.platform === "win32" || process.platform === "darwin") {
    app.setLoginItemSettings({ openAtLogin: enabled, path: executable, args: ["--automatic"] });
    return;
  }
  const destination = path.join(process.env.XDG_CONFIG_HOME || path.join(app.getPath("home"), ".config"), "autostart", "hwp2x.desktop");
  if (!enabled) {
    await unlink(destination).catch(error => { if (error.code !== "ENOENT") throw error; });
    return;
  }
  if (/[\r\n]/.test(executable)) throw new Error("자동 실행 경로에 줄바꿈이 있습니다");
  const quoted = executable.replace(/([\\"`$])/g, "\\$1").replace(/%/g, "%%");
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `[Desktop Entry]\nType=Application\nName=hwp2x\nExec="${quoted}" --automatic\nTerminal=false\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}
