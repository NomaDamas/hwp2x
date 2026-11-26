'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

function regularFile(file, nonempty = false) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile(), `일반 파일이 아닙니다: ${file}`);
  if (nonempty) assert(stat.size > 0, `빈 파일입니다: ${file}`);
}

function filesUnder(root, relative) {
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = `${relative}/${entry.name}`;
    if (entry.isDirectory()) result.push(...filesUnder(root, name));
    else {
      assert(entry.isFile(), `지원하지 않는 파일 종류입니다: ${name}`);
      result.push(name);
    }
  }
  return result.sort();
}

function verifyAsarTree(root, archive, directory, patterns, asar, minimatch) {
  regularFile(archive, true);
  const included = name => patterns.some(p => !p.startsWith('!') && minimatch(name, p, { dot: true }))
    && !patterns.some(p => p.startsWith('!') && minimatch(name, p.slice(1), { dot: true }));
  const expected = filesUnder(root, directory).filter(included);
  assert(expected.length > 0, `검증할 원본 파일이 없습니다: ${directory}`);
  const actual = asar.listPackage(archive).map(name => name.replace(/^\//, ''))
    .filter(name => name.startsWith(`${directory}/`) && !asar.statFile(archive, name).files).sort();
  assert.deepEqual(actual, expected, `ASAR 파일 목록 불일치: ${directory}`);
  for (const name of expected) {
    assert(!asar.statFile(archive, name, false).link, `ASAR 링크는 허용하지 않습니다: ${name}`);
    assert(fs.readFileSync(path.join(root, name)).equals(asar.extractFile(archive, name)),
      `ASAR 바이트 불일치: ${name}`);
  }
  return expected.length;
}

function verifyNativeResources(root, resources, entries) {
  for (const arch of ['x86', 'x64']) {
    const source = `electron/native/${arch}/FilePathCheckerModule.dll`;
    const destination = `hancom/${arch}/FilePathCheckerModule.dll`;
    assert(entries.some(entry => entry.from === source && entry.to === destination),
      `extraResources 설정 누락: ${arch}`);
    const from = path.join(root, source);
    const to = path.join(resources, destination);
    regularFile(from, true);
    regularFile(to, true);
    assert(fs.readFileSync(from).equals(fs.readFileSync(to)), `DLL 바이트 불일치: ${to}`);
  }
  return 2;
}

function verifyWindowsArtifacts(output, pkg) {
  const product = pkg.build.productName;
  const template = pkg.build.portable.artifactName;
  assert.equal(typeof template, 'string', 'portable artifactName 설정이 필요합니다');
  const seen = new Set();
  for (const arch of ['x64', 'ia32']) {
    const directory = arch === 'ia32' ? path.join(output, 'ia32') : output;
    const installer = `${product} Setup ${pkg.version}${arch === 'ia32' ? '-ia32' : ''}.exe`;
    const portable = template.replaceAll('${version}', pkg.version).replaceAll('${arch}', arch);
    assert(!portable.includes('${'), `지원하지 않는 artifactName 변수: ${portable}`);
    for (const name of [installer, portable]) {
      const file = path.resolve(directory, name);
      assert(!seen.has(file), `산출물 경로 중복: ${file}`);
      seen.add(file);
      regularFile(file, true);
    }
  }
  return seen.size;
}

function main(argv = process.argv.slice(2)) {
  assert.deepEqual(argv, ['--verify-existing'], '사용법: node electron/qa/package-check.cjs --verify-existing');
  const root = path.resolve(__dirname, '../..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const asar = require('@electron/asar');
  const { minimatch } = require('minimatch');
  const output = path.resolve(root, pkg.build.directories.output);
  const linux = path.join(output, 'linux-unpacked/resources');
  const archive = path.join(linux, 'app.asar');
  const failures = [];
  function check(label, work) {
    try {
      const count = work();
      console.log(`PASS ${label}: ${count}개`);
    } catch (error) {
      failures.push(label);
      console.error(`FAIL ${label}: ${error.message}`);
    }
  }
  check('Linux 패키지 버전', () => {
    regularFile(archive, true);
    const packed = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
    assert.equal(packed.version, pkg.version, '패키지 버전 불일치');
    assert.equal(packed.name, pkg.name, '패키지 이름 불일치');
    return 1;
  });
  for (const directory of ['electron/dist', 'electron/design']) {
    check(`Linux ASAR ${directory}`, () => verifyAsarTree(root, archive, directory, pkg.build.files, asar, minimatch));
  }
  for (const relative of ['linux-unpacked', 'win-unpacked', 'ia32/win-ia32-unpacked']) {
    check(`${relative} native DLL`, () => verifyNativeResources(root,
      path.join(output, relative, 'resources'), pkg.build.extraResources));
  }
  check('Windows x64/ia32 설치 및 portable 존재', () => verifyWindowsArtifacts(output, pkg));
  assert.equal(failures.length, 0, `패키지 검증 실패: ${failures.join(', ')}`);
  console.log('PASS 기존 패키지 검증 완료 (Windows 실행/설치 검증 아님)');
}

module.exports = { regularFile, filesUnder, verifyAsarTree, verifyNativeResources, verifyWindowsArtifacts, main };
if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
