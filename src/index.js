// Check a project against defects that were measured rather than reported.
//
// Every finding here was reproduced locally against a named version. None of it comes from an issue
// tracker — most of these have never been filed, because a silent defect is one nobody notices.
//
// The scan is deliberately conservative. Resolving which packages you depend on is exact, so that is
// what drives the report. Guessing whether your code triggers a defect is not exact, so a source
// match is reported as a stronger signal rather than as a verdict, and only where the pattern is
// specific enough to mean something.

import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative, extname} from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const DATA = require('./findings.json');

export const findings = DATA.findings;

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.json', '.yml', '.yaml']);
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out', 'vendor', '.cache']);
// Files that describe defects rather than contain them. Without this the tool reports itself, and a
// lockfile is a list of names, not code anyone wrote.
const SKIP_FILES = new Set(['findings.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

/**
 * Which packages the project actually depends on, and at which version where that can be resolved.
 * Declared ranges come from package.json; resolved versions come from node_modules when present,
 * which is what actually runs.
 */
export function resolveDependencies(directory) {
  const manifest = readJson(join(directory, 'package.json'));
  const declared = new Map();
  if (manifest) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (!declared.has(name)) declared.set(name, {name, range, field, version: null});
      }
    }
  }

  // A transitive dependency still runs in your process, so the lockfile matters as much as the
  // manifest. This reads the two common shapes without taking a dependency to do it.
  const lock = readJson(join(directory, 'package-lock.json'));
  if (lock?.packages) {
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path.startsWith('node_modules/')) continue;
      const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      const existing = declared.get(name);
      if (existing) existing.version ??= entry.version ?? null;
      else declared.set(name, {name, range: null, field: 'transitive', version: entry.version ?? null});
    }
  }

  for (const entry of declared.values()) {
    if (entry.version) continue;
    const installed = readJson(join(directory, 'node_modules', entry.name, 'package.json'));
    if (installed?.version) entry.version = installed.version;
  }
  return declared;
}

function* walkSource(directory, depth = 0) {
  if (depth > 12) return;
  let entries;
  try { entries = readdirSync(directory, {withFileTypes: true}); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      yield* walkSource(full, depth + 1);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)) && !SKIP_FILES.has(entry.name)) {
      yield full;
    }
  }
}

/** Look for the specific strings that make a finding apply, where a specific string exists. */
export function scanSource(directory, wanted) {
  const patterns = wanted
    .filter((f) => f.triggerPattern)
    .map((f) => ({id: f.id, regex: new RegExp(f.triggerPattern)}));
  if (patterns.length === 0) return new Map();

  const hits = new Map();
  for (const file of walkSource(directory)) {
    let size;
    try { size = statSync(file).size; } catch { continue; }
    if (size > MAX_FILE_BYTES) continue;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const {id, regex} of patterns) {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = regex.exec(lines[i]);
        if (!match) continue;
        if (!hits.has(id)) hits.set(id, []);
        const list = hits.get(id);
        if (list.length < 10) {
          list.push({file: relative(directory, file), line: i + 1, text: lines[i].trim().slice(0, 120)});
        }
      }
    }
  }
  return hits;
}

const SEVERITY_ORDER = {high: 0, medium: 1, low: 2};

/**
 * Check a project directory against the findings.
 *
 * @param {string} directory
 * @param {{scanSource?: boolean}} [options]
 */
export function check(directory = process.cwd(), options = {}) {
  const {scanSource: shouldScan = true} = options;
  const dependencies = resolveDependencies(directory);

  const applicable = findings.filter((f) => dependencies.has(f.package));
  const universal = findings.filter((f) => f.weeklyDownloads === null);
  const hits = shouldScan ? scanSource(directory, [...applicable, ...universal]) : new Map();

  const results = [...applicable, ...universal].map((finding) => {
    const dependency = dependencies.get(finding.package) ?? null;
    return {
      ...finding,
      installedVersion: dependency?.version ?? null,
      via: dependency?.field ?? 'language',
      sourceMatches: hits.get(finding.id) ?? [],
    };
  });

  results.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return b.sourceMatches.length - a.sourceMatches.length;
  });

  return {
    directory,
    dependencyCount: dependencies.size,
    findingsChecked: findings.length,
    results,
    confirmed: results.filter((r) => r.sourceMatches.length > 0),
  };
}

// Built rather than written literally: an escape byte in a source file survives a lot of tooling
// badly, and this is unambiguous.
const ESC = String.fromCharCode(27);
const BOLD = ESC + '[1m';
const DIM = ESC + '[2m';
const RESET = ESC + '[0m';
const RED = ESC + '[31m';
const YELLOW = ESC + '[33m';
const GREEN = ESC + '[32m';

/** Render a report as text. Colour is omitted when stdout is not a terminal. */
export function formatReport(report, {color = false} = {}) {
  const c = (code, text) => (color ? code + text + RESET : text);
  const out = [];
  const {results, confirmed, dependencyCount, findingsChecked} = report;

  if (results.length === 0) {
    out.push(c(GREEN, 'No measured defects apply to this project.'));
    out.push(c(DIM, `Checked ${findingsChecked} findings against ${dependencyCount} dependencies.`));
    return out.join('\n');
  }

  out.push(c(BOLD, `${results.length} of ${findingsChecked} measured defects apply to this project.`));
  if (confirmed.length > 0) {
    out.push(c(YELLOW, `${confirmed.length} also matched something in your source.`));
  }
  out.push('');

  for (const r of results) {
    const severity = r.severity === 'high' ? c(RED, 'high  ') : c(YELLOW, 'medium');
    const version = r.installedVersion ? `@${r.installedVersion}` : '';
    out.push(`${severity}  ${c(BOLD, r.package + version)}  ${r.headline}`);
    out.push(`        ${r.detail.split('\n')[0]}`);
    out.push(c(DIM, `        applies if: ${r.affectsYouIf}`));
    if (r.sourceMatches.length > 0) {
      out.push(c(YELLOW, `        found in your source:`));
      for (const m of r.sourceMatches.slice(0, 3)) {
        out.push(c(YELLOW, `          ${m.file}:${m.line}  ${m.text}`));
      }
      if (r.sourceMatches.length > 3) out.push(c(DIM, `          ...and ${r.sourceMatches.length - 3} more`));
    }
    out.push(c(DIM, `        measured against ${r.package}@${r.measuredAgainst}`));
    out.push('');
  }

  out.push(c(DIM, 'Every finding was reproduced locally before being listed. Run with --json for the full data,'));
  out.push(c(DIM, 'including a runnable reproduction for each one.'));
  return out.join('\n');
}
