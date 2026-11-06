import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { buildIssueUrl, ISSUE_REPO } from "./report";

test("이슈 URL은 저장소·제목·버그 라벨·한국어 본문을 포함한다", () => {
  const url = new URL(buildIssueUrl({ title: "변환 오류", system: { 운영체제: "Windows 11", 한컴: "2024" }, errors: ["오류 발생"], logTail: "최근 기록" }));
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.pathname, `/${ISSUE_REPO}/issues/new`);
  assert.equal(url.searchParams.get("title"), "변환 오류");
  assert.equal(url.searchParams.get("labels"), "bug");
  const body = url.searchParams.get("body")!;
  for (const text of ["재현 단계", "시스템 정보", "Windows 11", "2024", "최근 오류", "오류 발생", "로그 끝부분", "최근 기록"]) assert.ok(body.includes(text));
});

test("인코딩된 URL은 긴 한글·이모지 로그에서도 최신 끝부분을 보존한다", () => {
  const result = buildIssueUrl({ title: "긴 로그", system: {}, errors: [], logTail: "이전😀한글".repeat(10000) + "최신 기록 끝" });
  assert.ok(result.length <= 7500);
  const body = new URL(result).searchParams.get("body")!;
  assert.ok(body.includes("최신 기록 끝"));
  assert.ok(!body.includes("�"));
});

test("시스템 정보·오류·제목도 과대하면 URL 제한을 지킨다", () => {
  const result = buildIssueUrl({ title: "제목😀".repeat(10000), system: { 환경: "환경".repeat(10000) }, errors: ["실패".repeat(10000)], logTail: "로그".repeat(10000) });
  assert.ok(result.length <= 7500);
  assert.equal(new URL(result).searchParams.get("labels"), "bug");
});

test("수십만 백틱 구간도 예외 없이 길이 제한을 지킨다", () => {
  const result = buildIssueUrl({ title: "백틱", system: {}, errors: ["a`".repeat(200000)], logTail: "b`".repeat(200000) });
  assert.ok(result.length <= 7500);
  assert.equal(new URL(result).searchParams.get("labels"), "bug");
});

test("제목·시스템 정보·오류·로그의 사용자 홈 경로를 가린다", () => {
  const windows = "C:\\Users\\홍길동\\문서\\test.hwp";
  const result = buildIssueUrl({ title: `${homedir()}/문서`, system: { 경로: windows, 슬래시: "d:/Users/Alice/Documents/a.hwp" }, errors: [`${homedir()}/오류`, windows], logTail: JSON.stringify({ path: windows }) });
  const url = new URL(result);
  const content = url.searchParams.get("title")! + url.searchParams.get("body")!;
  assert.ok(!content.includes(homedir()));
  assert.ok(!content.includes("홍길동"));
  assert.ok(!content.includes("Alice"));
  assert.ok(content.includes("~"));
  assert.ok(content.includes("test.hwp"));
});
