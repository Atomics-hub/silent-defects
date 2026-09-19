import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {check, findings, resolveDependencies, formatReport} from '../src/index.js';

const ESC = String.fromCharCode(27);

const project = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'silent-defects-test-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), {recursive: true});
    writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
};

test('every finding carries what a reader needs to check it', () => {
  assert.ok(findings.length >= 10);
  for (const f of findings) {
    for (const field of ['id', 'package', 'measuredAgainst', 'severity', 'headline', 'detail', 'reproduce', 'affectsYouIf']) {
      assert.ok(f[field], `${f.id} is missing ${field}`);
    }
    assert.ok(['high', 'medium', 'low'].includes(f.severity), `${f.id} severity`);
  }
  assert.equal(new Set(findings.map((f) => f.id)).size, findings.length, 'ids are unique');
});

test('a project with none of the affected packages reports only the language-level finding', () => {
  const dir = project({'package.json': {name: 'clean', dependencies: {'left-pad': '^1.0.0'}}});
  const report = check(dir);
  assert.ok(report.results.every((r) => r.weeklyDownloads === null), 'only the JSON built-in applies');
  assert.equal(report.confirmed.length, 0);
});

test('a declared dependency is matched', () => {
  const dir = project({'package.json': {name: 'app', dependencies: {bytes: '^3.1.2'}}});
  const report = check(dir);
  const ids = report.results.map((r) => r.id);
  assert.ok(ids.includes('bytes-ignores-iec-units'));
  assert.ok(ids.includes('bytes-guesses-at-malformed-input'));
});

test('a transitive dependency from the lockfile is matched too', () => {
  const dir = project({
    'package.json': {name: 'app', dependencies: {express: '^5.0.0'}},
    'package-lock.json': {packages: {'node_modules/bytes': {version: '3.1.2'}}},
  });
  const report = check(dir);
  const hit = report.results.find((r) => r.id === 'bytes-ignores-iec-units');
  assert.ok(hit, 'found through the lockfile');
  assert.equal(hit.installedVersion, '3.1.2');
  assert.equal(hit.via, 'transitive');
});

test('a source match is reported with file and line', () => {
  const dir = project({
    'package.json': {name: 'app', dependencies: {bytes: '^3.1.2'}},
    'src/server.js': "app.use(express.json({limit: '5MiB'}));\n",
  });
  const report = check(dir);
  const hit = report.results.find((r) => r.id === 'bytes-ignores-iec-units');
  assert.equal(hit.sourceMatches.length, 1);
  assert.equal(hit.sourceMatches[0].file, 'src/server.js');
  assert.equal(hit.sourceMatches[0].line, 1);
  assert.equal(report.confirmed.length, 1);
});

test('an IEC unit without the package is not reported', () => {
  const dir = project({
    'package.json': {name: 'app', dependencies: {}},
    'src/a.js': "const size = '5MiB';\n",
  });
  const report = check(dir);
  assert.ok(!report.results.some((r) => r.id === 'bytes-ignores-iec-units'));
});

test('node_modules and lockfiles are not scanned as source', () => {
  const dir = project({
    'package.json': {name: 'app', dependencies: {bytes: '^3.1.2'}},
    'node_modules/somedep/index.js': "const x = '5MiB';\n",
    'package-lock.json': {packages: {}},
  });
  const report = check(dir);
  const hit = report.results.find((r) => r.id === 'bytes-ignores-iec-units');
  assert.equal(hit.sourceMatches.length, 0, 'other code is not your problem');
});

test('the tool does not report its own findings file', () => {
  const dir = project({
    'package.json': {name: 'app', dependencies: {bytes: '^3.1.2'}},
    'findings.json': JSON.stringify({headline: "bytes.parse('5MiB') returns 5"}),
  });
  const report = check(dir);
  const hit = report.results.find((r) => r.id === 'bytes-ignores-iec-units');
  assert.equal(hit.sourceMatches.length, 0);
});

test('scanning can be turned off', () => {
  const dir = project({
    'package.json': {name: 'app', dependencies: {bytes: '^3.1.2'}},
    'src/a.js': "const size = '5MiB';\n",
  });
  assert.equal(check(dir, {scanSource: false}).confirmed.length, 0);
  assert.equal(check(dir, {scanSource: true}).confirmed.length, 1);
});

test('the IEC pattern matches the forms people write and not near-misses', () => {
  const dir = (line) => project({
    'package.json': {name: 'app', dependencies: {bytes: '^3.1.2'}},
    'src/a.js': line,
  });
  const matches = (line) => check(dir(line)).results.find((r) => r.id === 'bytes-ignores-iec-units').sourceMatches.length;
  assert.equal(matches("limit: '5MiB'\n"), 1);
  assert.equal(matches("limit: '1.5GiB'\n"), 1);
  assert.equal(matches("limit: '10 KiB'\n"), 1);
  assert.equal(matches("limit: '5MB'\n"), 0, 'SI units are a different finding');
  assert.equal(matches("const miB = 5;\n"), 0, 'a variable name is not a size');
});

test('resolveDependencies reads every manifest field', () => {
  const dir = project({'package.json': {
    name: 'app', dependencies: {a: '1'}, devDependencies: {b: '1'},
    optionalDependencies: {c: '1'}, peerDependencies: {d: '1'},
  }});
  const deps = resolveDependencies(dir);
  for (const name of ['a', 'b', 'c', 'd']) assert.ok(deps.has(name), name);
});

test('a missing or broken package.json does not throw', () => {
  const empty = mkdtempSync(join(tmpdir(), 'silent-defects-empty-'));
  assert.doesNotThrow(() => check(empty));
  const broken = project({'package.json': 'not json at all'});
  assert.doesNotThrow(() => check(broken));
});

test('the report renders without colour codes when colour is off', () => {
  const dir = project({'package.json': {name: 'app', dependencies: {bytes: '^3.1.2'}}});
  const text = formatReport(check(dir), {color: false});
  assert.ok(text.includes('bytes'));
  assert.ok(!text.includes(ESC), 'no escape codes');
  const colored = formatReport(check(dir), {color: true});
  assert.ok(colored.includes(ESC), 'escape codes when asked for');
});
