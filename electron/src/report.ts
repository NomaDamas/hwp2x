import { homedir } from "node:os";

export const ISSUE_REPO = "NomaDamas/hwp2x";
const MAX_URL = 7500;

function redact(text: string): string {
  const home = homedir();
  if (home) {
    text = text.split(home).join("~");
    text = text.split(home.replace(/\\/g, "/")).join("~");
    text = text.split(home.replace(/\\/g, "\\\\")).join("~");
  }
  return text.replace(/[a-z]:[\\/]+Users[\\/]+[^\\/\r\n"'<>|]+/gi, "~");
}

function printable(value: unknown): string {
  if (typeof value === "string") return redact(value);
  try {
    const seen = new WeakSet<object>();
    return redact(JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      if (typeof item === "object" && item !== null) {
        if (seen.has(item)) return "[순환 참조]";
        seen.add(item);
      }
      return item;
    }) ?? "없음");
  } catch { return "[표시 불가]"; }
}

export function buildIssueUrl(input: {
  title: string;
  system: Record<string, unknown>;
  errors: string[];
  logTail: string;
}): string {
  let title = redact(input.title);
  const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  let system = Object.entries(input.system).map(([key, value]) => `| ${cell(redact(key))} | ${cell(printable(value))} |`).join("\n");
  let errors = redact(input.errors.join("\n"));
  let logs = redact(input.logTail);
  const fenced = (text: string): string => {
    let longest = 2;
    for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
    const fence = "`".repeat(longest + 1);
    return `${fence}\n${text}\n${fence}`;
  };
  const url = (): string => {
    const body = `## 재현 단계\n1. \n2. \n\n## 기대한 동작\n\n## 실제 동작\n\n## 시스템 정보\n| 항목 | 값 |\n| --- | --- |\n${system}\n\n## 최근 오류\n${fenced(errors || "없음")}\n\n## 로그 끝부분\n${fenced(logs || "없음")}\n\n공유 전에 개인정보와 문서 경로를 확인해 주세요.`;
    return `https://github.com/${ISSUE_REPO}/issues/new?${new URLSearchParams({ title, body, labels: "bug" })}`;
  };
  let result = url();
  // 최신 로그를 우선 보존하되, 인코딩된 최종 URL 길이로 판단한다.
  for (const field of ["logs", "errors", "system", "title"] as const) {
    if (result.length <= MAX_URL) break;
    const original = field === "logs" ? logs : field === "errors" ? errors : field === "system" ? system : title;
    const assign = (length: number): void => {
      let value = field === "logs" || field === "errors" ? original.slice(original.length - length) : original.slice(0, length);
      value = value.replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, "");
      if (field === "logs") logs = value;
      else if (field === "errors") errors = value;
      else if (field === "system") system = value;
      else title = value;
    };
    assign(0);
    result = url();
    if (result.length > MAX_URL) continue;
    let low = 0;
    let high = original.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      assign(mid);
      if (url().length <= MAX_URL) low = mid;
      else high = mid - 1;
    }
    assign(low);
    result = url();
  }
  return result;
}
