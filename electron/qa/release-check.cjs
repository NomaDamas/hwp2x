'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
async function main() {
  assert.deepEqual(process.argv.slice(2), ['--download-and-verify']);
  const root = path.resolve(__dirname, '../..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const gate = spawnSync(process.execPath, [path.join(__dirname, 'inventory-check.cjs'), '--final-evidence'], { stdio: 'inherit' });
  if (gate.error || gate.status !== 0) {
    console.error(JSON.stringify({ version: pkg.version, passed: false, stage: 'required-evidence', downloaded: false, published: false, reason: gate.error?.message || '필수 GUI·Windows 실측 증거 미충족', remaining: ['필수 항목 행동 증거', '실제 Windows·한컴 검증', '재다운로드본 실행 검증'] }));
    process.exitCode = 1;
    return;
  }
  const version = pkg.version;
  const files = [`hwp2x Setup ${version}.exe`, `hwp2x-${version}-portable-x64.exe`, `ia32/hwp2x Setup ${version}-ia32.exe`, `ia32/hwp2x-${version}-portable-ia32.exe`, `hwp2x_${version}_amd64.deb`];
  const downloadDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hwp2x-release-'));
  console.log(JSON.stringify({ downloadDir }));
  for (const relative of files) {
    const local = path.join(root, pkg.build.directories.output, relative);
    const asset = path.basename(relative).replaceAll(' ', '.');
    const url = `https://github.com/NomaDamas/hwp2x/releases/download/v${encodeURIComponent(version)}/${encodeURIComponent(asset)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    assert(response.ok, `다운로드 실패 ${response.status}: ${url}`);
    const digest = crypto.createHash('sha256');
    const downloaded = path.join(downloadDir, asset);
    const output = await fs.promises.open(downloaded, 'wx', 0o600);
    try {
      for await (const chunk of response.body) {
        digest.update(chunk);
        await output.writeFile(chunk);
      }
      await output.sync();
    } finally { await output.close(); }
    const actual = digest.digest('hex');
    const localDigest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(local)) localDigest.update(chunk);
    const expected = localDigest.digest('hex');
    assert.equal(actual, expected, `공개 파일과 후보 불일치: ${asset}`);
    const savedDigest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(downloaded)) savedDigest.update(chunk);
    assert.equal(savedDigest.digest('hex'), expected, `저장된 다운로드 파일 불일치: ${asset}`);
    console.log(JSON.stringify({ url, downloaded, sha256: actual, bytesEqual: true }));
  }
  assert.equal(process.platform, 'linux', '재다운로드 deb 실행 검증은 Linux에서 수행해야 합니다');
  const extracted = path.join(downloadDir, 'linux');
  const unpack = spawnSync('dpkg-deb', ['--extract', path.join(downloadDir, `hwp2x_${version}_amd64.deb`), extracted], { stdio: 'inherit' });
  assert(!unpack.error && unpack.status === 0, '재다운로드 deb 추출 실패');
  const executable = path.join(extracted, 'opt', pkg.build.productName, pkg.name);
  assert(fs.lstatSync(executable).isFile(), '추출된 실행 파일이 일반 파일이 아닙니다');
  fs.accessSync(executable, fs.constants.X_OK);
  const archive = path.join(path.dirname(executable), 'resources', 'app.asar');
  const candidateArchive = path.join(root, pkg.build.directories.output, 'linux-unpacked/resources/app.asar');
  assert(fs.readFileSync(archive).equals(fs.readFileSync(candidateArchive)), '재다운로드본 내부 코드 불일치');
  const smoke = spawnSync(process.execPath, [path.join(__dirname, 'full-menu-check.cjs'), '--packaged'], {
    stdio: 'inherit', timeout: 3600000, env: { ...process.env, HWP2X_EXECUTABLE: executable },
  });
  assert(!smoke.error && smoke.status === 0, '재다운로드본 전체 GUI 검사 실패');
  console.log(JSON.stringify({ passed: true, version, executable, downloadDir, executionPlatform: 'linux', windowsExecution: '최종 증거 검사에서 별도 요구' }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
