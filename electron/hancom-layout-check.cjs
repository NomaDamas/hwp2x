// Runs the real Hancom discovery PowerShell script (from electron/dist/hancom.js) with pwsh on fake installs.
// Only the registry (treated as empty) and the drive list are replaced; the folder search runs as shipped.
// Usage: npm run build && node electron/hancom-layout-check.cjs
const { detectHancom, parseDiscoveryOutput } = require('./dist/hancom.js');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  let script = '';
  await detectHancom('win32', async (_file, args) => { script = Buffer.from(args.at(-1), 'base64').toString('utf16le'); return { stdout: '[]' }; });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-layout-'));
  const installs = [
    'C/Program Files (x86)/HNC/Office 2018/HOffice100/Bin/Hwp.exe',
    'C/Program Files (x86)/HNC/Office 2020/HOffice110/Bin/Hwp.exe',
    'C/Program Files/HNC/Office 2022/HOffice120/Bin/Hwp.exe',
    'C/Program Files/Hnc/Office 2024/HOffice130/Bin/Hwp.exe',
    'D/Hnc/Office NEO/HOffice100/Bin/Hwp.exe',
    'C/Hancom/HOffice130/Bin/Hwp.exe',
  ];
  const unrelated = 'C/Games/Hwp.exe';
  try {
    for (const file of [...installs, unrelated]) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), 'MZ');
    }
    const body = script
      .replace('[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)', '[pscustomobject]@{} | Add-Member -PassThru ScriptMethod OpenSubKey { $null } | Add-Member -PassThru ScriptMethod Dispose {}')
      .replace("[IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady }", "@('C','D') | ForEach-Object { [pscustomobject]@{ RootDirectory = [IO.DirectoryInfo](Join-Path $env:LAYOUT $_) } }")
      .replace("foreach ($root in @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'), [Environment]::GetEnvironmentVariable('ProgramW6432'))) { if ($root) { $roots.Add($root) } }", '');
    assert.notEqual(body, script, '치환 대상이 감지 스크립트에 있어야 함');
    console.log(`$ LAYOUT=${root} pwsh -NoProfile -NonInteractive -Command <electron/src/hancom.ts 감지 스크립트>`);
    const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', body], { encoding: 'utf8', env: { ...process.env, LAYOUT: root } });
    const found = parseDiscoveryOutput(out);
    for (const item of found) {
      const rel = path.relative(root, item.path).replaceAll('\\', '/');
      const folder = rel.match(/HOffice(\d+)/)?.[0] ?? '';
      console.log(`찾음  ${rel.replace(/^([CD])\//, '$1:/')}  | 폴더 버전 ${folder} | 파일 버전 "${item.version ?? ''}" | 사용 가능 ${item.available} | ${item.unavailableReason ?? ''}`);
    }
    const rels = found.map(item => path.relative(root, item.path).replaceAll('\\', '/')).sort();
    assert.deepEqual(rels, [...installs].sort(), '6개 설치를 모두 찾고 관계없는 Hwp.exe는 제외');
    console.log(`결과: ${found.length}/6 설치 발견, 관계없는 ${unrelated.replace(/^C\//, 'C:/')} 제외`);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
