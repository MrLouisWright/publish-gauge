# publish-gauge

> Check what `npm publish` will actually ship, before you publish it.

Most broken npm releases are caused by packaging, not code. `main` points at a `dist/` folder that was never built. `exports` names a file that `files` leaves out. The `.d.ts` imports a sibling declaration that was not shipped, so users silently get `any`. The bin has no shebang. A `.env` file or an `.npmrc` with a token goes out to the whole world. `publish-gauge` runs `npm pack`, opens the real tarball, and checks it the way your users will consume it: every entry point must exist **and load**, types must resolve, and nothing that should stay private is included. Each problem comes with a file, a severity and a **concrete fix**.

CLI, library and GitHub Action. Node.js 18+, **zero runtime dependencies**. By Louis Wright.

## Features

- **The real tarball:** runs `npm pack --json` (with `--ignore-scripts` unless you pass `--run-scripts`), or checks an existing `.tgz` with `--tarball`. A built-in tar reader means nothing extra to install.
- **Entry points exist:** `main` (with Node's `.js`/`.json`/`index.js` fallbacks), `module`, `bin`, `types`/`typings`, and every `exports` target, including nested conditions, subpaths and `*` patterns.
- **Entry points load:** each Node-facing entry is `require`d or `import`ed from a sandbox copy of the tarball, using your installed `node_modules`. Missing shipped files and undeclared runtime dependencies are reported as errors. Declared dependencies that simply aren't installed are reported as info.
- **Types resolve:** relative imports, `import()` types and `/// <reference path>` in every shipped `.d.ts` must point at shipped files. `types` must be listed before `import`/`require`/`default` in `exports`.
- **Nothing leaks:** `.env*` (but not `.env.example`), private keys and certificates, `.npmrc` (flagged as containing a token when it has one), `.netrc` and credential files. Junk such as tests, fixtures, CI config, coverage, logs, editor files and tool configs is grouped by folder.
- **Budgets:** packed size, unpacked size and per-file size.
- **Manifest sanity:** valid name and version, `"private": true`, `file:`/`link:`/`workspace:` dependency specs, bin shebangs and CRLF line endings, `.mjs`/`.cjs` targets under the wrong condition, source maps pointing at unshipped sources, and missing README/LICENSE.
- **Output:** text, JSON, SARIF 2.1.0 and Markdown; `--fail-on`; exit codes 0/1/2; allowlist entries with expiry dates.

## Rules

| Rule | Default severity | What it catches |
|---|---|---|
| `pack-failed` | critical | npm pack failed |
| `secret-file` | critical | A file that usually holds secrets would be published |
| `entry-missing` | critical | main / module / bin / exports target is not in the tarball |
| `manifest-invalid` | critical | package.json name or version is invalid |
| `entry-load-failed` | high | An entry point throws when loaded from the packed tarball |
| `types-missing` | high | types / typings / exports "types" target is not in the tarball |
| `types-broken-reference` | high | A shipped .d.ts imports a file that is not shipped |
| `bin-shebang` | high | bin file has no #! line or uses CRLF line endings |
| `local-dependency` | high | A dependency uses file:, link: or workspace: and cannot be installed from the registry |
| `private-package` | medium | package.json has "private": true, so npm publish will refuse |
| `size-budget` | medium | Packed or unpacked size exceeds the budget |
| `exports-types-order` | medium | "types" is not the first condition, so TypeScript may skip it |
| `exports-format-mismatch` | medium | "require" points at .mjs or "import" at .cjs |
| `readme-missing` | medium | No README in the tarball |
| `license-missing` | medium | No LICENSE file and no license field |
| `junk-file` | low | Tests, CI config, coverage, logs or editor files would be published |
| `large-file` | low | A single file is larger than the per-file budget |
| `sourcemap-orphan` | low | A source map references sources that are not shipped |
| `files-field-missing` | low | No "files" field and no .npmignore: everything not git-ignored is published |
| `entry-load-skipped` | info | An entry point could not be load-tested (missing dependency or unsupported type) |
| `allowlist-expired` | medium | Allowlist entry has expired |
| `allowlist-unused` | info | Allowlist entry matched nothing |

## Install and run

```bash
npx publish-gauge                         # in the package directory
npx publish-gauge --run-scripts           # let prepack/prepare build dist/ first
npx publish-gauge --max-size 200kb --fail-on medium
npx publish-gauge --tarball my-lib-1.2.3.tgz
```

Run it after `npm ci` so entry points can be load-tested with your dependencies installed. Use it as the last step before `npm publish` in a release workflow.

### Sample output

```text
publish-gauge — my-lib@1.0.0
npm pack: 9 files, 665 B packed, 676 B unpacked

CRITICAL .env .env would be published [secret-file]
         ↳ fix: Remove it from the package (add it to .npmignore or narrow "files"), and rotate anything it contained if it was ever published.
CRITICAL package.json:4 main → "dist/index.js" is not in the tarball [entry-missing]
         ↳ fix: Ship dist/index.js (check "files" and .npmignore). Build before packing, or add its folder to "files".
HIGH     bin/cli.js:1 bin/cli.js has no "#!/usr/bin/env node" line, so it will not run as a command on macOS/Linux [bin-shebang]
         ↳ fix: Add "#!/usr/bin/env node" as the first line.
HIGH     lib/load.js require("lib/load.js") failed: Error: Cannot find module './not-shipped-helper.js' [entry-load-failed]
         ↳ fix: A file it imports is not shipped; check "files" / .npmignore.
HIGH     package.json:5 types → "dist/index.d.ts" is not in the tarball [types-missing]
         ↳ fix: Ship dist/index.d.ts (check "files" and .npmignore). Build before packing, or add its folder to "files".
HIGH     package.json:11 dependencies.sibling is "file:../sibling", which users cannot install from the registry [local-dependency]
         ↳ fix: Publish sibling and depend on a version range instead.
HIGH     types/index.d.ts:1 types/index.d.ts imports "./missing", which is not in the tarball, so consumers get "any" or a compile error [types-broken-reference]
         ↳ fix: Ship the declaration for ./missing (check "files"), or fix the path.
MEDIUM   package.json No README in the tarball, so the npm page will be empty [readme-missing]
         ↳ fix: Add README.md at the package root.
MEDIUM   package.json:2 No "license" field and no LICENSE file [license-missing]
         ↳ fix: Add "license": "MIT" (or your licence) and a LICENSE file.
MEDIUM   package.json:7 exports["."].import points at a CommonJS file (./lib/esm.cjs) [exports-format-mismatch]
         ↳ fix: Point "import" at an ESM build, or use "default".
MEDIUM   package.json:7 exports["."]: "types" comes after "import"; TypeScript stops at the first matching condition [exports-types-order]
         ↳ fix: Move "types" to be the first key of the condition object.
LOW      lib/util.js.map lib/util.js.map points at 1 source file(s) that are not shipped (e.g. src/util.ts) [sourcemap-orphan]
         ↳ fix: Ship the sources, inline them with sourcesContent, or stop publishing the maps.
LOW      package.json:2 No "files" allowlist and no .npmignore: every file not ignored by .gitignore is published [files-field-missing]
         ↳ fix: Add "files": ["dist", ...] listing what users need.
LOW      test/a.test.js test/a.test.js (19 B) is not needed at runtime [junk-file]
         ↳ fix: Use a "files" allowlist in package.json (or .npmignore) to leave it out.

2 critical, 5 high, 4 medium, 3 low
✔ Passing (fail-on: none).
```

## Options

```text
publish-gauge 1.0.0 — check what npm publish will ship before you publish

Usage: publish-gauge [dir] [options]

Checks
      --tarball <file.tgz>      Check an existing tarball instead of running npm pack
      --run-scripts             Run prepack/prepare scripts while packing (default: --ignore-scripts)
      --max-size <size>         Packed size budget, e.g. 500kb, 2mb
      --max-unpacked-size <s>   Unpacked size budget
      --max-file-size <size>    Per-file budget (default 1mb)
      --no-load                 Do not load-test entry points
      --allow-private           Do not report "private": true
      --ignore-files <globs>    Files to skip in content checks (comma-separated)

Common
  -c, --config <file>     JSON config (default: .publish-gauge.json or "publishGauge" in package.json)
  -f, --format <fmt>      text (default) | json | sarif | markdown
      --json <file>       Also write a JSON report
      --sarif <file>      Also write SARIF 2.1.0
      --markdown <file>   Also write Markdown (e.g. for a job summary)
      --fail-on <sev>     critical | high | medium | low | info | none (default: high)
      --list-rules        Print rules and default severities
      --no-fixes          Hide fix suggestions in text output
      --no-color          Disable colours
  -v, --version / -h, --help

Exit codes: 0 = passed, 1 = findings at or above --fail-on, 2 = usage, config or read error.
```

## Configuration and allowlist

Options can live in `.publish-gauge.json` (or a `"publishGauge"` key in `package.json`, or `--config <file>`):

```json
{
  "failOn": "medium",
  "severity": { "large-file": "low" },
  "allowlist": [
    { "rule": "junk-file", "file": "assets/wasm/*.wasm", "reason": "WASM binary is the product", "expires": "2027-03-31" }
  ],
  "maxSize": "500kb"
}
```

- **`severity`** changes a rule's severity, or turns it `"off"`.
- **`allowlist`** entries suppress matching findings. Each needs a `reason` and matches on any combination of `rule`, `file`, `subject` (globs with `*`) and `match` (a substring of the message). Add `expires` (`YYYY-MM-DD`) so the exception is time-boxed: once it lapses the finding comes back along with an `allowlist-expired` finding (medium). Entries that no longer match anything are reported as `allowlist-unused` (info).

Other config keys: `maxSize`, `maxUnpackedSize`, `maxFileSize`, `runScripts`, `allowPrivate`, `allowJunk`, `ignoreFiles`, `loadTimeout` (ms), `"load": false` and `"types": false`.

## Output and exit codes

- `--format text` (default), `json`, `sarif` (SARIF 2.1.0 for GitHub code scanning) or `markdown` (for job summaries and PR comments). `--json`, `--sarif` and `--markdown` write extra report files in the same run.
- `--fail-on <severity>` sets the threshold (`critical`, `high`, `medium`, `low`, `info`, `none`; default `high`).
- Exit codes: **0** passed, **1** findings at or above `--fail-on`, **2** usage, config or read error.

## GitHub Action

```yaml
permissions:
  contents: read
  security-events: write   # only needed for the SARIF upload
jobs:
  publish-gauge:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with: { persist-credentials: false }
      - uses: MrLouisWright/publish-gauge@v1
        with:
          fail-on: high
          sarif: publish-gauge.sarif
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with: { sarif_file: publish-gauge.sarif }
```

| Input | Description | Default |
|---|---|---|
| `path` | Project directory | `.` |
| `max-size` | Packed size budget, e.g. 500kb or 2mb | `` |
| `tarball` | Check an existing .tgz instead of running npm pack | `` |
| `run-scripts` | Run prepack/prepare scripts while packing (true/false) | `false` |
| `fail-on` | Failure threshold | `high` |
| `config` | Config file path | |
| `sarif` / `json` | Write SARIF / JSON report to this path | |
| `job-summary` | Add the Markdown report to the job summary | `true` |
| `args` | Extra CLI arguments | |

The action runs the bundled CLI with Node 20; it has no dependencies to install. Pin it to a commit SHA if your policy requires it.

## Library

```js
import { check, readTarball, exportTargets } from 'publish-gauge';
const report = check('.', { maxSize: '500kb' });
console.log(report.info.packedSize, report.findings.length);
exportTargets({ '.': { import: './a.mjs', require: './a.cjs' } });
```

Types are included.

## Requirements

Node.js 18 or newer. Zero runtime dependencies.

## Licence

MIT © Louis Wright. See [LICENSE](LICENSE).
