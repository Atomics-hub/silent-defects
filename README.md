# silent-defects

Check your dependencies against defects that were **measured and reproduced**, not reported.

```sh
npx silent-defects
```

```
2 of 4 measured defects apply to this project.

high    serialize-error@13.0.1  deserializeError is exponential in the depth of the cause chain
        0.4 ms at depth 5, 10.6 ms at 10, 339 ms at 15 and 11 seconds at depth 20, on a
        payload of 6.6 KB.
        applies if: you wrap errors with `cause` through several layers and send them across
        a boundary as JSON
        measured against serialize-error@13.0.1

medium  croner@10.0.1  croner fires an hourly job twice at the same instant across spring forward
        ...
```

## Why this exists

A defect that throws gets reported, and then it gets fixed. A defect that returns a plausible wrong
answer does not get reported, because nobody notices — which means it does not appear in an issue
tracker, a changelog, or an advisory database. `npm audit` will not tell you about any of these,
because none of them is a vulnerability.

Every finding here was reproduced locally against the latest version of the package at the time,
and each project's own tracker was searched first. None of it is inferred from documentation. What is
in the list:

| package | weekly | what it does |
| --- | --- | --- |
| `serialize-error` | 24.4M | `deserializeError` is exponential in cause depth — **11 seconds** at depth 20 |
| `croner` | 6.8M | hourly jobs fire twice at the same instant across spring forward |
| `rrule` | 2.7M | an hour early on spring-forward when the machine's own zone transitions that day |
| `parse-duration` | 575k | `P1DT2H` drops the day; `P1M` and `PT1M` are the same number |

The list is short on purpose. Each project's tracker was searched before anything was listed, and
findings that turned out to have a prior report, a documented setting that fixes them, or a
convention behind them were removed. What remains is only what nobody has said before.

## What it does, and what it deliberately does not

**Resolving your dependencies is exact**, so that is what drives the report. It reads `package.json`
and `package-lock.json`, so a defect reaching you through a transitive dependency — which is how most
people have `serialize-error` — is found.

**Guessing whether your code triggers a defect is not exact**, so the source scan is treated as a
stronger signal rather than a verdict, and only runs where the pattern is specific enough to mean
something. An ISO 8601 duration like `P1DT2H` in your source, near a `parse-duration` dependency, is
worth showing you. "You use `croner`" is reported as applying to you; "your jobs run in a zone with
daylight saving" is not something a regex can know, so it does not pretend to.

It never reports a defect for a package you do not depend on, never scans `node_modules`, and never
phones home. It is a file read and some regular expressions.

## Usage

```sh
npx silent-defects                # check the current directory
npx silent-defects ./some/project # check somewhere else
npx silent-defects --json         # full data, including a runnable reproduction for each finding
npx silent-defects --list         # every known finding, whether or not it applies here
npx silent-defects --no-scan      # dependencies only, skip the source scan
npx silent-defects --quiet        # print nothing unless something applies
```

Exit code is `1` when a finding matched something in your source, `0` otherwise — so it can gate a
build if you want it to, though starting with `--no-scan` in a report-only mode is the gentler
introduction.

## As a library

```js
import {check, findings, formatReport} from 'silent-defects';

const report = check(process.cwd());
for (const result of report.results) {
  console.log(result.package, result.headline, result.reproduce);
}
```

`findings` is the raw list, also importable as `silent-defects/findings.json` if you want the data
without the code.

## Each finding carries

- `headline` and `detail` — what it does and why it happens
- `reproduce` — runnable as written, so you can confirm it yourself in ten seconds
- `affectsYouIf` — the condition that makes it matter to you specifically
- `measuredAgainst` — the exact version the behaviour was observed on
- `workaround` — what to do instead

## Honest limits

- **It cannot find everything.** The list is what has been measured, which is a small corner of npm.
  A clean report means none of *these* apply, not that your dependencies are correct.
- **A listed defect may not affect you.** Depending on `croner` is not a bug; running an hourly job
  in a daylight-saving zone where a second run is unsafe is. The report says which condition matters
  so you can decide.
- **Findings can go stale.** Each one names the version it was measured against. If a library fixes
  the behaviour, the finding becomes wrong, and that is worth
  [reporting](https://github.com/Atomics-hub/silent-defects/issues) so it can be removed.
- These are not security vulnerabilities and this is not a replacement for `npm audit`. It is the
  complement: `npm audit` covers what was reported, this covers what nobody noticed.

## Install

```sh
npm install --save-dev silent-defects
```

Zero dependencies, Node 18 or newer.

## License

MIT
