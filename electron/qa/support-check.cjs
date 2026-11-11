'use strict';
// 실제 배포 패키지에서 설정 › 지원(로그 보기·새로 고침·복사·버그 리포트)을 GUI로 조작해 검증한다.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runEvidence, ensureDisplay } = require('./common/evidence.cjs');

if (!process.argv.includes('--packaged')) {
  console.error('사용법: node electron/qa/support-check.cjs --packaged');
  process.exit(2);
}

const MAX_BYTES = 5 * 1024 * 1024;
const today = () => `hwp2x-${new Date().toISOString().slice(0, 10)}.log`;

async function prepare(evidence) {
  // 회전 임계값을 넘긴 오늘 로그를 미리 두어 시작 시 실제 회전 경로를 태운다.
  const logs = path.join(evidence.profile, 'logs');
  await fs.mkdir(logs, { recursive: true });
  const filler = JSON.stringify({ event: '회전 전 기록', home: os.homedir() }) + '\n';
  await fs.writeFile(path.join(logs, today()), filler.repeat(Math.ceil(MAX_BYTES / Buffer.byteLength(filler)) + 1));
  evidence.isolation = { preRotationLog: path.join(logs, today()), injected: ['clipboard.writeText 실패 1회', 'dialog.showMessageBox 응답', 'shell.openExternal 기록'] };
}

async function inspect({ app, page, evidence, capture }) {
  const act = async (label, run) => { evidence.actions.push({ type: 'click', label, at: new Date().toISOString() }); await run(); };
  const observe = (label, value) => evidence.observations.push({ label, value });
  const logs = path.join(evidence.profile, 'logs');
  const current = path.join(logs, today());
  await app.evaluate(({ dialog, shell }) => {
    globalThis.__support = { dialogs: [], external: [], answer: 'cancel' };
    dialog.showMessageBox = async (_window, options) => {
      globalThis.__support.dialogs.push(options);
      return { response: globalThis.__support.answer === 'cancel' ? options.cancelId : 0, checkboxChecked: false };
    };
    shell.openExternal = async url => { globalThis.__support.external.push(url); };
  });

  const rotated = await fs.stat(current + '.1');
  assert.ok(rotated.size > MAX_BYTES, '시작 시 5MB 초과 로그가 .1로 회전');
  assert.ok((await fs.stat(current)).size < MAX_BYTES);
  observe('rotation', { rotatedBytes: rotated.size });

  const longErrorStart = '지원검사-긴오류-시작';
  const longErrorEnd = '지원검사-긴오류-끝';
  const longError = longErrorStart + '긴 한글 오류😀'.repeat(400) + longErrorEnd;
  await page.evaluate(message => window.hwp2x.reportError(message, 'stack'), longError);

  await act('설정', () => page.getByText('설정', { exact: true }).first().click());
  await act('로그 보기', () => page.getByRole('button', { name: '로그 보기' }).click());
  const dialog = page.getByRole('dialog', { name: '상세 로그' });
  await dialog.waitFor();
  const area = dialog.getByLabel('로그 내용');
  const shown = await area.inputValue();
  assert.ok(!shown.includes('\uFFFD'), '한글 인코딩 손상 없음');
  assert.ok(!shown.includes('회전 전 기록'), '회전 후 현재 파일만 표시');
  assert.ok(shown.includes('실행 환경'));
  assert.ok(shown.includes(longErrorStart), '긴 렌더러 오류 시작 보존');
  assert.ok(shown.includes(longErrorEnd), '긴 렌더러 오류 끝 보존');
  assert.ok(shown.includes('[긴 오류 중간 생략]'), '긴 렌더러 오류의 중간 생략을 명시');
  observe('log-view', { chars: shown.length, hasKorean: /[가-힣]/.test(shown), longErrorStart: shown.includes(longErrorStart), longErrorTail: shown.includes(longErrorEnd), explicitTruncation: shown.includes('[긴 오류 중간 생략]') });
  await capture('로그 보기');

  await fs.writeFile(current, '');
  await act('새로 고침(빈 로그)', () => dialog.getByRole('button', { name: '새로 고침' }).click());
  await page.waitForFunction(() => document.querySelector('[aria-label="로그 내용"]')?.value === '로그가 아직 없습니다.');
  observe('empty-log', await area.inputValue());
  await capture('빈 로그');

  await fs.appendFile(current, JSON.stringify({ event: '새 기록', message: '한글 확인 ✓' }) + '\n', 'utf8');
  await act('새로 고침', () => dialog.getByRole('button', { name: '새로 고침' }).click());
  await page.waitForFunction(() => document.querySelector('[aria-label="로그 내용"]')?.value.includes('한글 확인 ✓'));

  const copyButton = dialog.getByRole('button', { name: /복사/ });
  await act('복사', () => copyButton.click());
  await dialog.getByText(/클립보드에 복사했습니다/).waitFor();
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  const afterCopy = await area.inputValue();
  assert.equal(copied, afterCopy, '복사 내용 = 화면 표시 내용');
  assert.ok(copied.includes('한글 확인 ✓'));
  observe('copy', { chars: copied.length });
  await capture('복사 완료');

  await app.evaluate(({ clipboard }) => {
    const original = clipboard.writeText;
    clipboard.writeText = () => { clipboard.writeText = original; throw new Error('injected'); };
  });
  await act('복사(클립보드 실패 주입)', () => copyButton.click());
  await page.getByText(/클립보드에 복사하지 못했습니다/).first().waitFor();
  observe('clipboard-failure', '한국어 실패 안내 표시');
  await capture('클립보드 실패');
  await act('닫기', () => dialog.getByRole('button', { name: '닫기' }).click());

  await page.evaluate(message => window.hwp2x.reportError(message), `${os.homedir()}/비밀문서/보안.hwp 열기 실패 ` + '오류'.repeat(3000));
  await act('작성 초안 열기(취소)', () => page.getByRole('button', { name: '작성 초안 열기' }).click());
  await page.waitForFunction(() => true);
  await new Promise(resolve => setTimeout(resolve, 500));
  let support = await app.evaluate(() => globalThis.__support);
  assert.equal(support.dialogs.length, 1);
  const consent = support.dialogs[0];
  assert.deepEqual(consent.buttons, ['브라우저에서 초안 열기', '취소']);
  assert.equal(consent.cancelId, 1, 'Esc/닫기는 취소');
  assert.equal(consent.defaultId, 1, '기본 선택은 취소');
  assert.match(consent.message, /로그 끝부분/);
  assert.match(consent.message, /자동 게시하지 않습니다/);
  assert.equal(support.external.length, 0, '취소 시 외부창 0');
  observe('report-cancel', { external: 0, message: consent.message, actualExternalTransmission: false, boundary: 'shell.openExternal을 기록 전용으로 대체한 상태에서 취소 시 호출 0 검증' });

  await app.evaluate(() => { globalThis.__support.answer = 'open'; });
  await act('작성 초안 열기(동의)', () => page.getByRole('button', { name: '작성 초안 열기' }).click());
  await new Promise(resolve => setTimeout(resolve, 1000));
  support = await app.evaluate(() => globalThis.__support);
  assert.equal(support.external.length, 1);
  const url = new URL(support.external[0]);
  assert.ok(support.external[0].length <= 2000, '긴 링크 2000자 이하');
  assert.equal(url.pathname, '/NomaDamas/hwp2x/issues/new');
  const body = url.searchParams.get('body');
  assert.ok(!body.includes(os.homedir()) && !body.includes(os.userInfo().username + '/'), '민감 경로 가림');
  assert.ok(body.includes('보안.hwp') || body.includes('로그 끝부분'));
  assert.ok(!body.includes('\uFFFD'));
  observe('report-open', { length: support.external[0].length, url: support.external[0], redactedBody: body, consent: support.dialogs.at(-1).message });
  await capture('신고 후');
  evidence.result = { rotated: true, copiedChars: copied.length, urlLength: support.external[0].length, longErrorPreserved: true, explicitTruncation: true, cancelExternalCalls: 0, actualExternalTransmission: false };
  evidence.changeOwnership = {
    step7: ['electron/src/logger.test.ts', 'electron/src/report.ts', 'electron/src/report.test.ts', 'electron/qa/support-check.cjs'],
    sharedForStep7: { 'electron/src/main.ts': '신고 기본·취소 응답, 전송 동의 문구, 클립보드 오류 안내', 'electron/src/preload.ts': '긴 렌더러 오류 앞뒤 보존과 중간 생략 표시' },
    otherSteps: { 'electron/design/live.js': '8단계 로그 표시 범위 문구와 초점 처리', 'electron/src/hancom.ts': '4단계 소유권 경계', 'electron/native/': '선행 한컴 파일 접근 승인 자료; 이번 지원 메뉴 수정 없음', 'dist-electron/': '검사용 빌드 산출물; 이번 지원 메뉴 작업에서 배포 ZIP 생성·업로드 없음' },
  };
  console.log(JSON.stringify({ supportResult: evidence.result, consent: consent.message, redactedDraftLength: body.length, evidenceScope: '실제 패키지 GUI, OS 동의 응답·외부 열기 기록 대체 및 클립보드 오류 주입' }));
}

if (!ensureDisplay(__filename)) runEvidence('support-check', inspect, prepare);
