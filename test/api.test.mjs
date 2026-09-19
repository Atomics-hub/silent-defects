import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {check, findings, resolveDependencies, formatReport} from '../src/index.js';

const ESC = String.fromCharCode(27);
const ISO = 'parse-duration-iso-day-dropped';
const CAUSE = 'serialize-error-exponential-on-cause-chains';

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
  assert.ok(findings.length >= 4);
  for (const f of findings) {
    for (const field of ['id', 'package', 'measuredAgainst', 'severity', 'headline', 'detail', 'reproduce', 'affectsYouIf']) {
      assert.ok(f[field], `${f.id} is missing ${field}`);
    }
    assert.ok(['high', 'medium', 'low'].includes(f.severity), `${f.id} severity`);
  }
  assert.equal(new Set(findings.map((f) => f.id)).size, findings.length, 'ids are unique');
});

test('nothing on the list has a prior report or a documented fix — that is the bar', () => {
  for (const f of findings) {
    assert.deepEqual(f.priorReports ?? [], [], `${f.id} carries a prior report`);
    assert.ok(!f.configurable, `${f.id} is marked configurable`);
  }
});

test('a project with none of the affected packages reports nothing', () => {
  const dir = project({'package.json': {name: 'clean', dependencies: {'left-pad': '^1.0.0'}}});
  const report = check(dir);
  assert.equal(report.results.length, 0);
  assert.equal(report.confirmed.length, 0);
  assert.match(formatReport(report), /No measured defects apply/);
});

test('a declared dependency is matched', () => {
  const dir = project({'package.json': {name: 'app', dependencies: {'serialize-error': '^13.0.1'}}});
  const ids = check(dir).results.map((r) => r.id);
  assert.ok(ids.includes(CAUSE));
  assert.ok(!ids.includes(ISO), 'a package that is not depended on is not reported');
});

test('a transitive dependency from the lockfile is matched too', () => {
  const dir = project({
    'package.json': {name: 'app', dependencies: {'some-framework': '^1.0.0'}},
    'package-lock.json': {packages: {'node_modules/croner': {version: '10.0.1'}}},
  });
  const hit = check(dir).results.find((r) => r.id === 'croner-duplicate-fire-across-dst');
  assert.ok(hit, 'found through the lockfile');
  assert.equal(hit.installedVersion, '10.0.1');
  assert.equal(hit.via, 'transitive');
});

test('a source match is reported with file and line', () => {
  const dir = project({
    'package.json': {name: 'app', dependencies: {'parse-duration': '^2.1.8'}},
    'src/retention.js': "const window = parse('P1DT2H');\n",
  });
  const report = check(dir);
  const hit = report.results.find((r) => r.id === ISO);
  assert.equal(hit.sourceMatches.length, 1);
  assert.equal(hit.sourceMatches[0].file, 'src/retention.js');
  assert.equal(hit.sourceMatches[0].line, 1);
  assert.equal(report.confirmed.length, 1);
});

test('a trigger string without the package is not reported', () => {
  const dir = project({
    'package.json': {name: 'app', dependencies: {}},
    'src/a.js': "const window = 'P1DT2H';\n",
  });
  assert.ok(!check(dir).results.some((r) => r.id === ISO));
});

test('node_modules and lockfiles are not scanned as source', () => {
  const dir = project({
    'package.json': {name: 'app', dependencies: {'parse-duration': '^2.1.8'}},
    'node_modules/somedep/index.js': "const x = 'P1DT2H';\n",
    'package-lock.json': {packages: {}},
  });
  const hit = check(dir).results.find((r) => r.id === ISO);
  assert.equal(hit.sourceMatches.length, 0, 'other code is not your problem');
});

test('the tool does not report its own findings file', () => {
  const dir = project({
    'package.json': {name: 'app', dependencies: {'parse-duration': '^2.1.8'}},
    'findings.json': JSON.stringify({headline: 'P1DT2H drops the day'}),
  });
  const hit = check(dir).results.find((r) => r.id === ISO);
  assert.equal(hit.sourceMatches.length, 0);
});

test('scanning can be turned off', () => {
  const dir = project({
    'package.json': {name: 'app', dependencies: {'parse-duration': '^2.1.8'}},
    'src/a.js': "parse('P1M');\n",
  });
  assert.equal(check(dir, {scanSource: false}).confirmed.length, 0);
  assert.equal(check(dir, {scanSource: true}).confirmed.length, 1);
});

test('the ISO pattern matches the durations the finding is about and not near-misses', () => {
  const dir = (line) => project({
    'package.json': {name: 'app', dependencies: {'parse-duration': '^2.1.8'}},
    'src/a.js': line,
  });
  const matches = (line) => check(dir(line)).results.find((r) => r.id === ISO).sourceMatches.length;
  assert.equal(matches("parse('P1DT2H')\n"), 1, 'a day component followed by a time');
  assert.equal(matches("parse('P1M')\n"), 1, 'a month component');
  assert.equal(matches("parse('P30D')\n"), 1, 'a day component alone');
  assert.equal(matches("parse('PT1H30M')\n"), 0, 'time-only durations are parsed correctly and are not flagged');
  assert.equal(matches("const P1 = 'x';\n"), 0, 'an identifier is not a duration');
  assert.equal(matches("parse('1h30m')\n"), 0, 'a human duration is a different thing');
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
  const dir = project({'package.json': {name: 'app', dependencies: {'serialize-error': '^13.0.1'}}});
  const text = formatReport(check(dir), {color: false});
  assert.ok(text.includes('serialize-error'));
  assert.ok(!text.includes(ESC), 'no escape codes');
  const colored = formatReport(check(dir), {color: true});
  assert.ok(colored.includes(ESC), 'escape codes when asked for');
});
