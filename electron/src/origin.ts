// Trust is decided by frame identity, not by comparing file paths: on Windows the frame URL and
// `__dirname` can spell the same file differently (8.3 short names, drive case, percent-encoding),
// which rejected every request from the real app page. Navigation away from the app page is
// blocked separately (`isSameDocument`), so the main frame of our window only ever shows our page.
export interface FrameRef { url: string; routingId: number; processId: number }

export function isAppFrame(frame: FrameRef | null | undefined, main: FrameRef): boolean {
  if (!frame || frame.routingId !== main.routingId || frame.processId !== main.processId) return false;
  try { return new URL(frame.url).protocol === "file:"; } catch { return false; }
}

export function isSameDocument(target: string, current: string): boolean {
  try {
    const a = new URL(target), b = new URL(current);
    a.hash = ""; b.hash = "";
    return a.protocol === "file:" && a.href === b.href;
  } catch { return false; }
}
