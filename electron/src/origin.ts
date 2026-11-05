import path from "node:path";
import { fileURLToPath } from "node:url";

// The renderer's frame URL may carry a hash (`#` links) and, on Windows, is `/C:/...` with
// percent-encoding, so it is compared as a file path rather than as a string.
export function isAppPage(url: string | undefined, page: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!url) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "file:" || parsed.host !== "") return false;
  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  let target: string;
  try { target = fileURLToPath(parsed, { windows }); } catch { return false; }
  const a = p.resolve(target), b = p.resolve(page);
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}
