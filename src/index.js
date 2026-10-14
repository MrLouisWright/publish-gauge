import { readFileSync, existsSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { join, posix, basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readTarball, npmPack, extract, readTar } from './tarball.js';
import { buildReport, UsageError } from './core.js';

export { readTar, readTarball, npmPack, extract };
export * from './core.js';

export const RULES = {
  'pack-failed': { severity: 'critical', title: 'npm pack failed' },
  'secret-file': { severity: 'critical', title: 'A file that usually holds secrets would be published' },
  'entry-missing': { severity: 'critical', title: 'main / module / bin / exports target is not in the tarball' },
  'manifest-invalid': { severity: 'critical', title: 'package.json name or version is invalid' },
  'entry-load-failed': { severity: 'high', title: 'An entry point throws when loaded from the packed tarball' },
  'types-missing': { severity: 'high', title: 'types / typings / exports "types" target is not in the tarball' },
  'types-broken-reference': { severity: 'high', title: 'A shipped .d.ts imports a file that is not shipped' },
  'bin-shebang': { severity: 'high', title: 'bin file has no #! line or uses CRLF line endings' },
  'local-dependency': { severity: 'high', title: 'A dependency uses file:, link: or workspace: and cannot be installed from the registry' },
  'private-package': { severity: 'medium', title: 'package.json has "private": true, so npm publish will refuse' },
  'size-budget': { severity: 'medium', title: 'Packed or unpacked size exceeds the budget' },
  'exports-types-order': { severity: 'medium', title: '"types" is not the first condition, so TypeScript may skip it' },
  'exports-format-mismatch': { severity: 'medium', title: '"require" points at .mjs or "import" at .cjs' },
  'readme-missing': { severity: 'medium', title: 'No README in the tarball' },
  'license-missing': { severity: 'medium', title: 'No LICENSE file and no license field' },
  'junk-file': { severity: 'low', title: 'Tests, CI config, coverage, logs or editor files would be published' },
  'large-file': { severity: 'low', title: 'A single file is larger than the per-file budget' },
  'sourcemap-orphan': { severity: 'low', title: 'A source map references sources that are not shipped' },
  'files-field-missing': { severity: 'low', title: 'No "files" field and no .npmignore: everything not git-ignored is published' },
  'entry-load-skipped': { severity: 'info', title: 'An entry point could not be load-tested (missing dependency or unsupported type)' },
};

const SECRET = [/(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[\w.-]+)?$/i, /(^|\/)\.npmrc$/, /(^|\/)\.pypirc$/, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, /\.(pem|key|p12|pfx|jks|keystore)$/i, /(^|\/)\.?(credentials|secrets?)(\.json|\.ya?ml)?$/i, /(^|\/)\.git-credentials$/, /(^|\/)\.netrc$/, /(^|\/)\.aws\/credentials$/];
const JUNK = [/(^|\/)(__tests__|__mocks__|test|tests|spec|specs|coverage|\.nyc_output|fixtures|\.github|\.circleci|\.vscode|\.idea|\.husky|\.changeset)\//, /\.(test|spec)\.[cm]?[jt]sx?$/, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /\.log$/, /\.(swp|swo|orig|rej|bak|tmp)$|~$/, /(^|\/)(\.eslintrc(\.\w+)?|\.prettierrc(\.\w+)?|\.editorconfig|\.travis\.yml|\.gitlab-ci\.yml|jest\.config\.\w+|vitest\.config\.\w+|tsconfig(\.[\w-]+)?\.json|\.babelrc|babel\.config\.\w+|rollup\.config\.\w+|webpack\.config\.\w+|\.gitattributes|\.nvmrc)$/, /\.tgz$/];

export function parseSize(v) {
  if (v == null || v === '' || v === false) return null; if (typeof v === 'number') return v;
  const m = /^\s*([\d.]+)\s*(b|kb|k|mb|m|gb|g)?\s*$/i.exec(String(v)); if (!m) throw new UsageError(`Invalid size "${v}" (use e.g. 500kb, 2mb)`);
  const u = (m[2] || 'b').toLowerCase()[0]; return Math.round(parseFloat(m[1]) * (u === 'k' ? 1024 : u === 'm' ? 1024 ** 2 : u === 'g' ? 1024 ** 3 : 1));
}
export const fmtSize = (n) => (n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n} B`);
const TS_CONDS = new Set(['import', 'require', 'default', 'node', 'module-sync', 'node-addons']);
const norm = (p) => posix.normalize(String(p).replace(/\\/g, '/')).replace(/^\.\//, '').replace(/^\/+/, '');

/** Collect every exports target as { path, conditions[], subpath }. */
export function exportTargets(exp) {
  const out = [];
  const walk = (v, subpath, conds) => {
    if (typeof v === 'string') out.push({ path: v, subpath, conditions: conds });
    else if (Array.isArray(v)) v.forEach((x) => walk(x, subpath, conds));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k.startsWith('.')) walk(x, k, conds); else walk(x, subpath, [...conds, k]); }
  };
  if (typeof exp === 'string' || Array.isArray(exp)) walk(exp, '.', []);
  else if (exp && typeof exp === 'object') { const sub = Object.keys(exp).some((k) => k.startsWith('.')); if (sub) for (const [k, v] of Object.entries(exp)) walk(v, k, []); else walk(exp, '.', []); }
  return out;
}
/** Condition objects (for ordering checks): [{ subpath, keys }] */
function conditionObjects(exp, subpath = '.', out = []) {
  if (!exp || typeof exp !== 'object' || Array.isArray(exp)) return out;
  const keys = Object.keys(exp);
  if (keys.some((k) => k.startsWith('.'))) { for (const [k, v] of Object.entries(exp)) conditionObjects(v, k, out); return out; }
  out.push({ subpath, keys }); for (const v of Object.values(exp)) conditionObjects(v, subpath, out); return out;
}
const globRe = (p) => new RegExp('^' + norm(p).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.+') + '$');

function resolveDts(from, spec, has) {
  const base = posix.join(posix.dirname(from), spec);
  const stem = base.replace(/\.(d\.)?([cm]?)(js|ts)x?$/, '');
  const ext = /\.([cm]?)(js|ts)x?$/.exec(base)?.[1] || '';
  const cands = [base, `${stem}.d.${ext}ts`, `${stem}.d.ts`, `${stem}.${ext}ts`, `${stem}.ts`, `${stem}.tsx`, `${base}.d.ts`, `${base}/index.d.ts`, `${stem}/index.d.ts`];
  return cands.some((c) => has(norm(c)));
}

export function analyze(dir, opts = {}) {
  dir = resolve(dir);
  const findings = []; const info = {};
  const add = (rule, subject, message, fix, loc = {}) => findings.push({ rule, severity: RULES[rule].severity, subject, file: loc.file || 'package.json', line: loc.line, message, fix });
  let entries; let packed = null; let tmp = null; let meta = null;
  const srcPkgPath = join(dir, 'package.json');
  try {
    if (opts.tarball) { if (!existsSync(opts.tarball)) throw new UsageError(`No such tarball: ${opts.tarball}`); entries = readTarball(opts.tarball); packed = statSync(opts.tarball).size; info.source = basename(opts.tarball); }
    else {
      if (!existsSync(srcPkgPath)) throw new UsageError(`No package.json in ${dir}`);
      try { ({ meta, tmp, tarball: info.tarball } = npmPack(dir, { runScripts: opts.runScripts, npm: opts.npm })); }
      catch (e) { if (!e.packFailed) throw e; add('pack-failed', 'npm pack', e.message, 'Fix the error above; npm publish would fail the same way.'); return { pkg: {}, info, findings }; }
      entries = readTarball(info.tarball); packed = meta?.size ?? statSync(info.tarball).size; info.source = 'npm pack';
    }
  } catch (e) { if (tmp) rmSync(tmp, { recursive: true, force: true }); throw e; }
  try {
    const files = new Map(entries.filter((e) => e.type === 'file').map((e) => [norm(e.path), e]));
    const has = (p) => files.has(norm(p));
    const pkgEntry = files.get('package.json');
    if (!pkgEntry) { add('manifest-invalid', 'package.json', 'The tarball has no package.json', 'Pack from the package root.'); return { pkg: {}, info, findings }; }
    let pkg; try { pkg = JSON.parse(pkgEntry.data.toString('utf8')); } catch (e) { add('manifest-invalid', 'package.json', `package.json does not parse: ${e.message}`, 'Fix the JSON.'); return { pkg: {}, info, findings }; }
    const pjText = pkgEntry.data.toString('utf8').split('\n');
    const lineOf = (k) => { const i = pjText.findIndex((l) => l.includes(`"${k}"`)); return i === -1 ? undefined : i + 1; };
    const unpacked = [...files.values()].reduce((a, e) => a + e.size, 0);
    Object.assign(info, { name: pkg.name, version: pkg.version, files: files.size, packedSize: packed, unpackedSize: unpacked, fileList: [...files.keys()].sort() });
    const ignore = (p) => (opts.ignoreFiles || []).some((g) => globRe(g.replace(/\*\*\/?/g, '*')).test(norm(p)));

    // manifest
    if (!pkg.name || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(pkg.name) || pkg.name.length > 214) add('manifest-invalid', 'name', `Invalid package name "${pkg.name ?? ''}"`, 'Use lowercase letters, digits, -, . and _ (optionally @scope/name), max 214 characters.', { line: lineOf('name') });
    if (!pkg.version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(pkg.version)) add('manifest-invalid', 'version', `Invalid version "${pkg.version ?? ''}"`, 'Use a SemVer version such as 1.0.0.', { line: lineOf('version') });
    if (pkg.private === true && !opts.allowPrivate) add('private-package', 'private', '"private": true is set, so npm publish will refuse to publish this package', 'Remove "private" if this package is meant to be published (or pass --allow-private for internal checks).', { line: lineOf('private') });
    for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies']) for (const [n, v] of Object.entries(pkg[k] || {})) if (/^(file|link|workspace|portal):/.test(String(v))) add('local-dependency', n, `${k}.${n} is "${v}", which users cannot install from the registry`, String(v).startsWith('workspace:') ? 'Publish with pnpm/yarn (they rewrite workspace: specs) or replace it with a real version range.' : `Publish ${n} and depend on a version range instead.`, { line: lineOf(n) });

    // entry points
    const buildHint = (pkg.scripts?.prepack || pkg.scripts?.prepare || pkg.scripts?.prepublishOnly) && !opts.runScripts && !opts.tarball ? ' If a prepack/prepare script builds it, re-run with --run-scripts.' : ` Build before packing, or add its folder to "files".`;
    const entryList = [];
    const need = (p, field, rule = 'entry-missing') => {
      if (typeof p !== 'string' || !p) return;
      const n = norm(p);
      if (p.includes('*')) { const re = globRe(p); if (![...files.keys()].some((f) => re.test(f))) add(rule, field, `${field} pattern "${p}" matches no file in the tarball`, `Ship the files it refers to.${buildHint}`, { line: lineOf(field.split(/[.[ ]/)[0]) }); return; }
      const ok = has(n) || (field === 'main' && (has(`${n}.js`) || has(`${n}.json`) || has(`${n}/index.js`)));
      if (!ok) add(rule, field, `${field} → "${p}" is not in the tarball`, `Ship ${n} (check "files" and .npmignore).${buildHint}`, { line: lineOf(field.split(/[.[ ]/)[0]) });
      return ok;
    };
    if (pkg.main) { if (need(pkg.main, 'main')) entryList.push({ path: has(norm(pkg.main)) ? norm(pkg.main) : [`${norm(pkg.main)}.js`, `${norm(pkg.main)}.json`, `${norm(pkg.main)}/index.js`].find(has), via: 'main' }); }
    else if (!pkg.exports && !pkg.bin && has('index.js')) entryList.push({ path: 'index.js', via: 'main (default)' });
    else if (!pkg.exports && !pkg.bin && !pkg.types && !opts.allowNoEntry && [...files.keys()].some((f) => /\.[cm]?js$/.test(f))) add('entry-missing', 'main', 'No "main" or "exports" and no index.js, so require/import of the package fails', 'Add "exports" (or "main") pointing at your entry file.', { line: lineOf('name') });
    if (pkg.module) need(pkg.module, 'module');
    const bins = typeof pkg.bin === 'string' ? { [pkg.name?.replace(/^@[^/]+\//, '') || 'bin']: pkg.bin } : pkg.bin || {};
    for (const [b, p] of Object.entries(bins)) {
      if (!need(p, `bin.${b}`)) continue;
      const text = files.get(norm(p)).data.toString('utf8', 0, 512);
      if (!text.startsWith('#!')) add('bin-shebang', `bin.${b}`, `${p} has no "#!/usr/bin/env node" line, so it will not run as a command on macOS/Linux`, 'Add "#!/usr/bin/env node" as the first line.', { file: norm(p), line: 1 });
      else if (/^#![^\n]*\r\n/.test(text)) add('bin-shebang', `bin.${b}`, `${p} has a CRLF shebang line ("env: node\\r: No such file or directory")`, 'Convert the file to LF line endings (add "* text=auto eol=lf" to .gitattributes).', { file: norm(p), line: 1 });
    }
    for (const t of exportTargets(pkg.exports)) {
      const label = `exports["${t.subpath}"]${t.conditions.length ? '.' + t.conditions.join('.') : ''}`;
      if (!t.path.startsWith('./')) { add('entry-missing', label, `${label} is "${t.path}"; exports targets must start with "./"`, `Use "./${norm(t.path)}".`, { line: lineOf('exports') }); continue; }
      const isTypes = t.conditions.includes('types') || /\.d\.[cm]?ts$/.test(t.path);
      const ok = need(t.path, label, isTypes ? 'types-missing' : 'entry-missing');
      if (t.conditions.at(-1) === 'require' && /\.mjs$/.test(t.path)) add('exports-format-mismatch', label, `${label} points at an ES module (${t.path})`, 'Point "require" at a .cjs/CommonJS build (or drop the condition).', { line: lineOf('exports') });
      if (t.conditions.at(-1) === 'import' && /\.cjs$/.test(t.path)) add('exports-format-mismatch', label, `${label} points at a CommonJS file (${t.path})`, 'Point "import" at an ESM build, or use "default".', { line: lineOf('exports') });
      if (ok && !isTypes && !t.path.includes('*') && /\.[cm]?js$/.test(t.path) && !t.conditions.some((c) => ['browser', 'worker', 'deno', 'bun', 'react-native', 'react-server', 'edge-light', 'workerd', 'development', 'production'].includes(c))) entryList.push({ path: norm(t.path), via: label, cond: t.conditions.at(-1) });
    }
    for (const c of conditionObjects(pkg.exports)) { const i = c.keys.indexOf('types'); const before = c.keys.slice(0, i).filter((k) => TS_CONDS.has(k)); if (i > 0 && before.length) add('exports-types-order', `exports["${c.subpath}"]`, `exports["${c.subpath}"]: "types" comes after ${before.map((k) => `"${k}"`).join(', ')}; TypeScript stops at the first matching condition`, 'Move "types" to be the first key of the condition object.', { line: lineOf('exports') }); }
    for (const f of ['types', 'typings']) if (pkg[f]) need(pkg[f], f, 'types-missing');

    // .d.ts references
    if (!opts.noTypes) for (const [p, e] of files) {
      if (!/\.d\.[cm]?ts$/.test(p)) continue;
      const text = e.data.toString('utf8'); const lines = text.split('\n');
      lines.forEach((l, i) => {
        const specs = [...l.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+|\.{1,2})['"]/g)].map((m) => m[1]);
        const ref = /^\s*\/\/\/\s*<reference\s+path\s*=\s*['"]([^'"]+)['"]/.exec(l); if (ref) specs.push(ref[1].startsWith('.') ? ref[1] : `./${ref[1]}`);
        for (const s of specs) if (!resolveDts(p, s, has)) add('types-broken-reference', s, `${p} imports "${s}", which is not in the tarball, so consumers get "any" or a compile error`, `Ship the declaration for ${s} (check "files"), or fix the path.`, { file: p, line: i + 1 });
      });
    }

    // content
    for (const [p, e] of files) {
      if (ignore(p)) continue;
      if (SECRET.some((r) => r.test(p)) || (/(^|\/)\.npmrc$/.test(p) && /_authToken|_auth|_password/.test(e.data.toString('utf8')))) add('secret-file', p, `${p} would be published${/\.npmrc$/.test(p) && /_authToken/.test(e.data.toString('utf8')) ? ' and contains an auth token' : ''}`, `Remove it from the package (add it to .npmignore or narrow "files"), and rotate anything it contained if it was ever published.`, { file: p });
      else if (!opts.allowJunk && JUNK.some((r) => r.test(p))) add('junk-file', p, `${p} (${fmtSize(e.size)}) is not needed at runtime`, 'Use a "files" allowlist in package.json (or .npmignore) to leave it out.', { file: p });
      if (e.size > (opts.maxFileSize ?? 1024 * 1024)) add('large-file', p, `${p} is ${fmtSize(e.size)} (budget ${fmtSize(opts.maxFileSize ?? 1024 * 1024)})`, 'Leave it out, compress it, or raise maxFileSize.', { file: p });
      if (/\.map$/.test(p) && !opts.noSourcemaps) { try { const m = JSON.parse(e.data.toString('utf8')); if (!m.sourcesContent?.length) { const miss = (m.sources || []).filter((s) => !/^(webpack|node|data):/.test(s)).map((s) => norm(posix.join(posix.dirname(p), (m.sourceRoot || '').replace(/^\/+/, ''), s))).filter((s) => !s.startsWith('..') && !has(s)); if (miss.length) add('sourcemap-orphan', p, `${p} points at ${miss.length} source file(s) that are not shipped (e.g. ${miss[0]})`, 'Ship the sources, inline them with sourcesContent, or stop publishing the maps.', { file: p }); } } catch { /* not JSON */ } }
    }
    // collapse junk per top folder
    const junk = findings.filter((f) => f.rule === 'junk-file');
    if (junk.length > 5) {
      const groups = new Map(); for (const f of junk) { const top = f.subject.includes('/') ? f.subject.split('/').slice(0, f.subject.split('/').findIndex((s, i, a) => JUNK[0].test(a.slice(0, i + 1).join('/') + '/')) + 1).join('/') + '/' : f.subject; (groups.get(top) || groups.set(top, []).get(top)).push(f); }
      findings.splice(0, findings.length, ...findings.filter((f) => f.rule !== 'junk-file'));
      for (const [top, list] of groups) { const size = list.reduce((a, f) => a + files.get(f.subject).size, 0); add('junk-file', top, list.length > 1 ? `${list.length} files (${fmtSize(size)}) not needed at runtime` : list[0].message, 'Use a "files" allowlist in package.json (or .npmignore) to leave it out.', { file: list.length > 1 ? top : list[0].file }); }
    }
    if (![...files.keys()].some((f) => /^readme(\.|$)/i.test(f))) add('readme-missing', 'README', 'No README in the tarball, so the npm page will be empty', 'Add README.md at the package root.');
    if (!pkg.license && ![...files.keys()].some((f) => /^(licen[cs]e|copying)(\.|-|$)/i.test(f))) add('license-missing', 'license', 'No "license" field and no LICENSE file', 'Add "license": "MIT" (or your licence) and a LICENSE file.', { line: lineOf('name') });
    if (!opts.tarball && !pkg.files && !existsSync(join(dir, '.npmignore'))) add('files-field-missing', 'files', 'No "files" allowlist and no .npmignore: every file not ignored by .gitignore is published', 'Add "files": ["dist", ...] listing what users need.', { line: lineOf('name') });

    // size budgets
    const maxSize = parseSize(opts.maxSize); const maxUnpacked = parseSize(opts.maxUnpackedSize);
    if (maxSize != null && packed > maxSize) add('size-budget', 'packed size', `Packed size ${fmtSize(packed)} exceeds the ${fmtSize(maxSize)} budget`, 'Leave out what users do not need, or raise maxSize.');
    if (maxUnpacked != null && unpacked > maxUnpacked) add('size-budget', 'unpacked size', `Unpacked size ${fmtSize(unpacked)} exceeds the ${fmtSize(maxUnpacked)} budget`, 'Leave out what users do not need, or raise maxUnpackedSize.');

    // load entry points
    if (!opts.noLoad && entryList.length) loadEntries({ dir, pkg, files, entryList, add, timeout: opts.loadTimeout ?? 15000 });
    return { pkg, info, findings };
  } finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
}

function loadEntries({ dir, pkg, files, entryList, add, timeout }) {
  const sandbox = extract([...files.values()]);
  try {
    if (existsSync(join(dir, 'node_modules'))) { try { symlinkSync(join(dir, 'node_modules'), join(sandbox, 'node_modules'), 'junction'); } catch { /* ignore */ } }
    const seen = new Set(); const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies }));
    for (const e of entryList) {
      const mode = e.cond === 'require' || /\.cjs$/.test(e.path) || /\.json$/.test(e.path) ? 'require' : e.cond === 'import' || /\.mjs$/.test(e.path) ? 'import' : pkg.type === 'module' ? 'import' : 'require';
      const key = `${mode}:${e.path}`; if (seen.has(key)) continue; seen.add(key);
      const abs = join(sandbox, e.path);
      const code = mode === 'require' ? `require(${JSON.stringify(abs)})` : `import(${JSON.stringify(new URL(`file://${abs.replace(/\\/g, '/').replace(/^([A-Za-z]:)/, '/$1')}`).href)}).catch((e) => { console.error(e && e.stack || e); process.exit(1); })`;
      const r = spawnSync(process.execPath, ['-e', code], { cwd: sandbox, encoding: 'utf8', timeout, env: { ...process.env, NODE_OPTIONS: '' }, input: '' });
      if (r.error?.code === 'ETIMEDOUT') { add('entry-load-skipped', e.via, `${e.via} (${e.path}) did not finish loading within ${timeout / 1000}s (top-level side effects?)`, 'Avoid long-running work at import time.', { file: e.path }); continue; }
      if (r.status === 0) continue;
      const err = (r.stderr || '').trim();
      const missing = /Cannot find (?:module|package) '([^']+)'/.exec(err)?.[1];
      const bare = missing && !/^[./]|^file:|^[A-Za-z]:/.test(missing) && !missing.startsWith(sandbox);
      const bareName = bare ? missing.split('/').slice(0, missing.startsWith('@') ? 2 : 1).join('/') : null;
      if (bare && declared.has(bareName)) { add('entry-load-skipped', e.via, `${e.via} (${e.path}) needs ${bareName}, which is not installed here`, 'Install dependencies (npm ci) before running publish-gauge to load-test entry points.', { file: e.path }); continue; }
      const firstLine = err.split('\n').find((l) => /Error|Cannot|SyntaxError/.test(l)) || err.split('\n').pop() || `exit code ${r.status}`;
      const msg = firstLine.replaceAll(sandbox + '/', '').replaceAll(sandbox, '').trim();
      const fix = bare ? `"${bareName}" is used at runtime but is not in "dependencies"; add it there.` : /Cannot find module/.test(err) ? 'A file it imports is not shipped; check "files" / .npmignore.' : /ERR_REQUIRE_ESM|require\(\) of ES Module|ERR_REQUIRE_ASYNC_MODULE/.test(err) ? 'Ship a CommonJS build for "require", or remove the "require" condition.' : 'Run the entry point from the packed tarball to reproduce.';
      add('entry-load-failed', e.via, `${mode}("${e.path}") failed: ${msg.slice(0, 300)}`, fix, { file: e.path });
    }
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
}

export function check(dir, opts = {}, config = {}, configFile) {
  const pick = (k) => opts[k] ?? config[k];
  const merged = { tarball: opts.tarball, runScripts: pick('runScripts'), maxSize: pick('maxSize'), maxUnpackedSize: pick('maxUnpackedSize'), maxFileSize: parseSize(pick('maxFileSize')) ?? undefined, noLoad: opts.noLoad ?? config.load === false, noTypes: config.types === false, allowPrivate: pick('allowPrivate'), allowJunk: pick('allowJunk'), ignoreFiles: [...(config.ignoreFiles || []), ...(opts.ignoreFiles || [])], loadTimeout: pick('loadTimeout'), npm: opts.npm };
  const { pkg, info, findings } = analyze(dir, merged);
  const tool = { name: 'publish-gauge', version: opts.toolVersion || '1.0.0', rules: RULES, emoji: '📦', defaultFile: 'package.json' };
  const line = info.files != null ? `${info.source}: ${info.files} files, ${fmtSize(info.packedSize)} packed, ${fmtSize(info.unpackedSize)} unpacked` : `${info.source || 'npm pack'} failed`;
  const { fileList, ...rest } = info;
  return buildReport(tool, `${pkg.name || basename(resolve(dir))}${pkg.version ? '@' + pkg.version : ''}`, findings, config, { now: opts.now, configFile, summaryLine: line, info: { ...rest, fileList: opts.listFiles ? fileList : undefined } });
}
