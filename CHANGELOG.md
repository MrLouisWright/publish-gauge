# Changelog

## 1.0.0 (2026-10-14)

First release, by Louis Wright.

- Packs with `npm pack --json` (scripts off unless `--run-scripts`) or reads an existing `.tgz` with a built-in tar reader.
- Entry points: `main`, `module`, `bin`, `types`/`typings`, and every `exports` target (conditions, subpaths and `*` patterns) must exist in the tarball.
- Entry points are loaded in a sandbox copy of the tarball (CommonJS via require, ESM via import) using the project's installed dependencies.
- Type declarations: relative imports and `/// <reference path>` in shipped `.d.ts` files must resolve; `types` condition must come first in `exports`.
- Content: secrets (.env, keys, .npmrc with tokens), junk (tests, CI config, coverage, logs, editor files), source maps pointing at unshipped sources, missing README/LICENSE.
- Size budgets for packed size, unpacked size and individual files.
- Manifest: `private`, local `file:`/`link:`/`workspace:` dependency specs, bin shebangs and CRLF line endings, `.mjs`/`.cjs` vs condition mismatches.
- Text/JSON/SARIF/Markdown output, `--fail-on`, exit codes 0/1/2, allowlist with expiry, severity overrides.
- Composite GitHub Action with job summary.
