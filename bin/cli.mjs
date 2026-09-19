#!/usr/bin/env node
import {check, formatReport, findings} from '../src/index.js';

const args = process.argv.slice(2);
const has = (...names) => names.some((n) => args.includes(n));

if (has('-h', '--help')) {
  console.log(`silent-defects — check a project against defects that were measured, not reported

  npx silent-defects [directory] [options]

  --json         print the full findings as JSON, including a runnable reproduction for each
  --list         print every known finding, whether or not it applies here
  --no-scan      skip the source scan and report on dependencies alone
  --quiet        print nothing unless something applies
  -h, --help     this

Exit code is 1 when a finding matched something in your source, 0 otherwise.`);
  process.exit(0);
}

if (has('--list')) {
  if (has('--json')) console.log(JSON.stringify(findings, null, 2));
  else for (const f of findings) console.log(`${f.severity.padEnd(6)}  ${f.package.padEnd(18)}  ${f.headline}`);
  process.exit(0);
}

const directory = args.find((a) => !a.startsWith('-')) ?? process.cwd();
const report = check(directory, {scanSource: !has('--no-scan')});

if (has('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else if (!has('--quiet') || report.results.length > 0) {
  console.log(formatReport(report, {color: process.stdout.isTTY}));
}

process.exitCode = report.confirmed.length > 0 ? 1 : 0;
