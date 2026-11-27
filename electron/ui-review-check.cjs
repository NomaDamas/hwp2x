// Real window: walk run → files → detail → settings → log → backup dialog at 1240 and 720 wide and assert
// the UI review fixes: honest status names, engine-specific help, keyboard-operable rows/filters, Esc-closable
// modal dialogs, notice line, no horizontal overflow, no U+FFFD.
// Usage: [HWP2X_EXECUTABLE=<packaged app>] xvfb-run -a node electron/ui-review-check.cjs
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const xml = text => `<?xml version="1.0" encoding="UTF-8"?><HWPML Version="2.8"><HEAD SecCnt="1"></HEAD><BODY><SECTION Id="0"><P><TEXT><CHAR>${text}</CHAR></TEXT></P></SECTION></BODY></HWPML>`;

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-uireview-'));
  const docs = path.join(temp, '아주 긴 이름의 문서 보관 폴더', '2026년 상반기 공문');
  await fs.mkdir(docs, { recursive: true });
  for (let i = 0; i < 6; i++) await fs.writeFile(path.join(docs, `문서${i}.hwpml`), xml(`문서 ${i}`));
  await fs.writeFile(path.join(docs, '깨진 파일.hwp'), 'not a hwp');
  await fs.writeFile(path.join(docs, '이미있음.hwpml'), xml('x'));
  await fs.writeFile(path.join(docs, '이미있음.hwpx'), 'existing');
  const args = ['--no-sandbox', `--user-data-dir=${path.join(temp, 'profile')}`];
  const env = { ...process.env, HWP2X_START_ROOT: docs };
  const app = await _electron.launch(process.env.HWP2X_EXECUTABLE ? { executablePath: process.env.HWP2X_EXECUTABLE, args, env } : { args: [...args, '.'], env });
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    const state = () => page.evaluate(() => window.hwp2x.state());
    const until = async (test, label) => { for (let i = 0; i < 300; i++) { if (test(await state())) return; await page.waitForTimeout(100); } throw new Error('시간 초과: ' + label); };
    const sane = async label => {
      for (const width of [1240, 720]) {
        await page.setViewportSize({ width, height: 860 });
        await page.waitForTimeout(200);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(over <= 0, `${label} ${width}px: 가로 넘침 ${over}px`);
        assert.ok(!(await page.evaluate(() => document.body.innerText)).includes('\uFFFD'), `${label}: 깨진 글자`);
      }
      await page.setViewportSize({ width: 1240, height: 860 });
    };
    const nav = name => page.getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) }).first();

    await until(s => s.root === docs, '시작 폴더');
    await sane('실행 준비');
    await page.getByRole('button', { name: /개 파일 변환$|^검색 후 변환$/ }).click();
    await until(s => s.phase === 'done', '변환 완료');
    await page.getByText('완료', { exact: true }).first().waitFor();
    await sane('완료');
    assert.equal(await page.getByText('텍스트·블록 일치').count(), 0, '비교하지 않은 결과에 "일치"라 부르지 않음');

    // Keyboard: menu items and the status filters are focusable and act on Enter.
    await nav('파일').focus();
    await page.keyboard.press('Enter');
    const failFilter = page.getByRole('button', { name: /^실패 \d+$/ });
    await failFilter.focus();
    await page.keyboard.press('Enter');
    assert.equal(await failFilter.getAttribute('aria-pressed'), 'true', '상태 필터 선택 상태 노출');
    const failRow = page.getByRole('button', { name: /깨진 파일\.hwp/ });
    await failRow.focus();
    await page.keyboard.press('Enter');
    await page.getByText('원인을 해결한 뒤 다시 시도할 수 있습니다', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '다시 시도', exact: true }).isEnabled(), true, '실패 파일은 다시 시도 가능');
    await sane('실패 상세');
    await page.getByRole('button', { name: '상세 닫기' }).click();

    await page.getByRole('button', { name: /^이미 변환됨\(건너뜀\) \d+$/ }).click();
    await page.getByRole('button', { name: /이미있음\.hwpml/ }).click();
    await page.getByText('덮어쓰지 않았습니다', { exact: false }).first().waitFor();
    assert.equal(await page.getByRole('button', { name: '다시 시도', exact: true }).isDisabled(), true, '건너뛴 파일은 다시 시도 없음');

    const converted = (await state()).counts.ok ? /^변환됨 \d+$/ : /^차이 있음 \d+$/;
    await page.getByRole('button', { name: converted }).click();
    await page.getByRole('button', { name: /문서\d\.hwpml/ }).first().click();
    await page.getByText('원본과 변환본의 글자(띄어쓰기 제외)가 얼마나 같은지', { exact: false }).waitFor();
    await page.getByText('확인 항목', { exact: true }).waitFor();
    await sane('변환됨 상세');

    // Backup dialog: modal, focus inside, Esc closes.
    await page.getByRole('button', { name: /^원본 백업 · \d+개$/ }).click();
    const dialog = page.getByRole('dialog', { name: '원본 백업' });
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute('aria-modal'), 'true');
    for (let i = 0; i < 20 && !(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))); i++) await page.waitForTimeout(50);
    assert.ok(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')), '대화상자 안으로 초점 이동');
    assert.equal(await dialog.getByRole('button', { name: '원본 백업', exact: true }).isDisabled(), true, '동의 전 백업 잠김');
    await sane('백업 대화상자');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });

    // Settings: the segmented control is a radio group; the log dialog closes with Esc.
    await nav('설정').click();
    assert.equal(await page.getByRole('radio', { name: '1', exact: true }).getAttribute('aria-checked'), String((await state()).workers === 1));
    await sane('설정');
    await page.getByRole('button', { name: '상세 로그 로그 보기', exact: true }).click();
    const log = page.getByRole('dialog', { name: '상세 로그' });
    await log.waitFor();
    await sane('로그');
    await page.keyboard.press('Escape');
    await log.waitFor({ state: 'detached' });

    // Feedback after an action: the result line stays visible as a status.
    await page.getByRole('button', { name: '한컴 다시 감지 다시 감지', exact: true }).click();
    for (let i = 0; i < 50 && !(await page.locator('[role=status]').count()); i++) await page.waitForTimeout(100);
    assert.ok(await page.locator('[role=status]').count() > 0, '작업 후 안내 표시');

    assert.deepEqual(errors, []);
    console.log('통과: 상태 이름, 엔진별 설명, 키보드 조작, 대화상자 Esc·초점, 안내 줄, 1240/720 가로 넘침 없음');
  } finally {
    await app.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
