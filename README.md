# silent-defects

Check your dependencies against defects that were **measured and reproduced**, not reported.

```sh
npx silent-defects
```

```
3 of 12 measured defects apply to this project.
1 also matched something in your source.

high    bytes@3.1.2  bytes.parse('5MiB') returns 5
        It reads the leading number and ignores an IEC unit entirely. An express body limit
        written limit: '5MiB' becomes a five-byte limit, so every request is rejected.
        found in your source:
          src/server.js:14  app.use(express.json({limit: '5MiB'}));
        measured against bytes@3.1.2
```

## Why this exists

A defect that throws gets reported, and then it gets fixed. A defect that returns a plausible wrong
answer does not get reported, because nobody notices — which means it does not appear in an issue
tracker, a changelog, or an advisory database. `npm audit` will not tell you about any of these,
because none of them is a vulnerability.

Every finding here was reproduced locally against a named version before it was listed. None of it is
inferred from documentation. A few examples of what is in the list:

| package | weekly | what it does |
| --- | --- | --- |
| `bytes` | 97.0M | `parse('5MiB')` returns **5** — the unit is ignored |
| `flat` | 21.7M | `{'a.b': 1, a: {b: 2}}` loses one of the two values |
| `serialize-error` | 24.4M | `deserializeError` is exponential in cause depth — **11 seconds** at depth 20 |
| `parse-duration` | — | `1,5h` is fifteen hours; `P1M` and `PT1M` are the same number |
| `croner` | 6.8M | hourly jobs fire twice at the same instant across spring forward |
| `superjson` | 7.0M | silently loses five value kinds, including `Error` and class instances |

## What it does, and what it deliberately does not

**Resolving your dependencies is exact**, so that is what drives the report. It reads `package.json`
and `package-lock.json`, so a defect reaching you through a transitive dependency — which is how most
people get `bytes` — is found.

**Guessing whether your code triggers a defect is not exact**, so the source scan is treated as a
stronger signal rather than a verdict, and only runs where the pattern is specific enough to mean
something. An IEC unit in a string near a `bytes` dependency is worth showing you. "You use `flat`"
is reported as applying to you; "your keys contain dots" is not something a regex can know, so it
does not pretend to.

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
- **A listed defect may not affect you.** Depending on `flat` is not a bug; flattening keys that
  contain dots is. The report says which condition matters so you can decide.
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
