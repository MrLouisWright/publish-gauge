import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { check, analyze, exportTargets, parseSize, readTar, RULES } from '../src/index.js';

const broken = new URL('./fixtures/broken', import.meta.url).pathname;
const root = new URL('..', import.meta.url).pathname;
const bin = new URL('../bin/publish-gauge.js', import.meta.url).pathname;
const rules = (dir, o) => analyze(dir, o).findings.map((f) => f.rule);
function proj(files) { const d = mkdtempSync(join(tmpdir(), 'pg-')); for (const [p, c] of Object.entries(files)) { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), typeof c === 'string' ? c : JSON.stringify(c, null, 2)); } return d; }
const good = (extra = {}) => ({ 'package.json': { name: 'good', version: '1.0.0', license: 'MIT', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } }, files: ['index.js', 'index.d.ts'], ...extra }, 'index.js': 'export const a = 1;\n', 'index.d.ts': 'export declare const a: number;\n', 'README.md': '# good\n', 'LICENSE': 'MIT\n' });

/** Minimal tar writer for tests. */
function tar(entries) {
  const blocks = [];
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content); const h = Buffer.alloc(512);
    h.write(`package/${name}`, 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(blocks));
}

test('broken fixture reports every planted problem', () => {
  const r = rules(broken);
  for (const x of ['secret-file', 'entry-missing', 'bin-shebang', 'entry-load-failed', 'types-missing', 'local-dependency', 'types-broken-reference', 'readme-missing', 'license-missing', 'exports-format-mismatch', 'exports-types-order', 'sourcemap-orphan', 'files-field-missing', 'junk-file']) assert.ok(r.includes(x), x);
});
test('this package packs clean', () => { assert.deepEqual(rules(root), []); });
test('a correct ESM package is clean and loads', () => { assert.deepEqual(rules(proj(good())), []); });
test('ESM entry that throws is reported; --no-load skips it', () => {
  const d = proj({ ...good(), 'index.js': 'throw new Error("boom at import");\n' });
  const f = analyze(d).findings.find((x) => x.rule === 'entry-load-failed');
  assert.match(f.message, /boom at import/);
  assert.ok(!rules(d, { noLoad: true }).includes('entry-load-failed'));
});
test('undeclared bare import is an error; declared but uninstalled is skipped', () => {
  const d = proj({ ...good(), 'index.js': 'import "left-pad-zz";\n' });
  assert.match(analyze(d).findings.find((x) => x.rule === 'entry-load-failed').fix, /dependencies/);
  const e = proj({ ...good({ dependencies: { 'left-pad-zz': '^1.0.0' } }), 'index.js': 'import "left-pad-zz";\n' });
  assert.ok(rules(e).includes('entry-load-skipped')); assert.ok(!rules(e).includes('entry-load-failed'));
});
test('size budgets and large files', () => {
  const d = proj({ ...good({ files: ['index.js', 'index.d.ts', 'big.bin'] }), 'big.bin': 'x'.repeat(40000) });
  const f = analyze(d, { maxSize: '100b', maxUnpackedSize: 2000, maxFileSize: 10000 }).findings.map((x) => x.rule);
  assert.equal(f.filter((x) => x === 'size-budget').length, 2); assert.ok(f.includes('large-file'));
  assert.equal(parseSize('2mb'), 2 * 1024 * 1024); assert.equal(parseSize('1.5k'), 1536); assert.throws(() => parseSize('lots'));
});
test('private packages and .npmrc tokens', () => {
  const d = proj({ ...good({ private: true, files: ['index.js', 'index.d.ts', '.npmrc'] }), '.npmrc': '//registry.npmjs.org/:_authToken=abc\n' });
  const f = analyze(d).findings; assert.ok(f.some((x) => x.rule === 'private-package'));
  assert.match(f.find((x) => x.rule === 'secret-file').message, /auth token/);
  assert.ok(!rules(d, { allowPrivate: true }).includes('private-package'));
});
test('.env.example is not a secret; ignoreFiles suppresses', () => {
  const d = proj({ ...good({ files: ['index.js', 'index.d.ts', '.env.example', 'certs'] }), '.env.example': 'A=\n', 'certs/dev.pem': 'x' });
  const f = analyze(d).findings.filter((x) => x.rule === 'secret-file'); assert.equal(f.length, 1); assert.equal(f[0].file, 'certs/dev.pem');
  assert.ok(!rules(d, { ignoreFiles: ['certs/*'] }).includes('secret-file'));
});
test('--tarball reads an existing tgz; subpath patterns', () => {
  const t = join(mkdtempSync(join(tmpdir(), 'pg-t-')), 'x-1.0.0.tgz');
  writeFileSync(t, tar({ 'package.json': JSON.stringify({ name: 'x', version: '1.0.0', license: 'MIT', exports: { './feat/*': './dist/feat/*.js', './gone/*': './dist/gone/*.js' } }), 'dist/feat/a.js': 'module.exports=1', 'README.md': '#' }));
  const f = analyze('.', { tarball: t }).findings;
  assert.deepEqual(f.map((x) => `${x.rule}:${x.subject}`), ['entry-missing:exports["./gone/*"]']);
  assert.equal(readTar(readFileSync(t)).length, 3);
});
test('exportTargets walks subpaths, conditions and arrays', () => {
  const t = exportTargets({ '.': { node: { import: './a.mjs', require: './a.cjs' }, default: ['./b.js'] }, './p': './p.js' });
  assert.deepEqual(t.map((x) => `${x.subpath}|${x.conditions.join('.')}|${x.path}`), ['.|node.import|./a.mjs', '.|node.require|./a.cjs', '.|default|./b.js', './p||./p.js']);
  assert.deepEqual(exportTargets('./i.js'), [{ path: './i.js', subpath: '.', conditions: [] }]);
});
test('pack failure is critical', () => {
  const d = proj({ 'package.json': { description: 'no name' } });
  assert.deepEqual(rules(d), ['pack-failed']);
});
test('CLI: exit codes, SARIF, list-rules, allowlist', () => {
  assert.equal(spawnSync(process.execPath, [bin, broken, '--fail-on', 'critical']).status, 1);
  assert.equal(spawnSync(process.execPath, [bin, broken, '--fail-on', 'none']).status, 0);
  assert.equal(spawnSync(process.execPath, [bin, '/nonexistent-dir-xyz']).status, 2);
  const s = JSON.parse(execFileSync(process.execPath, [bin, broken, '-f', 'sarif', '--fail-on', 'none'], { encoding: 'utf8' }));
  assert.equal(s.version, '2.1.0'); assert.ok(s.runs[0].results.length >= 10);
  const l = execFileSync(process.execPath, [bin, '--list-rules'], { encoding: 'utf8' }); for (const k of Object.keys(RULES)) assert.ok(l.includes(k));
  const rep = check(broken, {}, { allowlist: [{ rule: 'secret-file', file: '.env', reason: 'fixture', expires: '2099-01-01' }] });
  assert.ok(!rep.findings.some((f) => f.rule === 'secret-file')); assert.equal(rep.suppressed.length, 1);
});
