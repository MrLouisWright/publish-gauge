import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPolicy, validateConfig, formatSarif, formatMarkdown, formatText, buildReport, exceeds, runCli, UsageError } from '../src/core.js';

const F = [{ rule: 'a', severity: 'high', file: 'x.js', line: 3, message: 'thing A', fix: 'do' }, { rule: 'b', severity: 'low', file: 'y.js', message: 'thing B' }];
const tool = { name: 'demo', version: '1.0.0', rules: { a: { severity: 'high', title: 'A' }, b: { severity: 'low', title: 'B' } } };
const now = new Date('2026-10-14T00:00:00Z');

test('core: allowlist suppresses and reports expired/unused', () => {
  const r = applyPolicy(F, { allowlist: [{ rule: 'a', reason: 'ok', expires: '2027-01-01' }, { file: 'zzz', reason: 'stale' }] }, { now });
  assert.equal(r.suppressed.length, 1);
  assert.ok(r.findings.some((f) => f.rule === 'allowlist-unused'));
  const e = applyPolicy(F, { allowlist: [{ rule: 'a', reason: 'ok', expires: '2026-01-01' }] }, { now });
  assert.ok(e.findings.some((f) => f.rule === 'allowlist-expired'));
  assert.ok(e.findings.some((f) => f.rule === 'a'), 'expired entry no longer suppresses');
});
test('core: severity overrides and off', () => {
  const r = applyPolicy(F, { severity: { a: 'info', b: 'off' } }, { now });
  assert.deepEqual(r.findings.map((f) => f.severity), ['info']);
});
test('core: config validation', () => {
  assert.throws(() => validateConfig({ allowlist: [{ rule: 'a' }] }), UsageError);
  assert.throws(() => validateConfig({ allowlist: [{ rule: 'a', reason: 'x', expires: 'soon' }] }), UsageError);
  assert.throws(() => validateConfig({ severity: { a: 'huge' } }), UsageError);
  assert.throws(() => validateConfig([]), UsageError);
  assert.ok(validateConfig({ allowlist: [{ match: 'x', reason: 'y' }] }));
});
test('core: formats', () => {
  const r = buildReport(tool, 'target', F, {}, { now });
  assert.ok(exceeds(r, 'high')); assert.ok(!exceeds(r, 'critical')); assert.ok(!exceeds(r, 'none'));
  const s = JSON.parse(formatSarif(r));
  assert.equal(s.version, '2.1.0'); assert.equal(s.runs[0].results.length, 2); assert.equal(s.runs[0].results[0].level, 'error');
  assert.match(formatMarkdown(r, { failOn: 'high' }), /❌ Failing/);
  assert.match(formatText(r, { failOn: 'critical' }), /Passing/);
});
test('core: runCli usage errors exit 2', async () => {
  const io = { stdout: { write() {} }, stderr: { write() {} } };
  const spec = { name: 'demo', version: '1', rules: tool.rules, options: {}, usage: '', help: '', run: async () => buildReport(tool, 't', [], {}) };
  assert.equal(await runCli(spec, ['--bogus'], io), 2);
  assert.equal(await runCli(spec, ['--fail-on', 'x'], io), 2);
  assert.equal(await runCli(spec, ['-f', 'xml'], io), 2);
  assert.equal(await runCli(spec, ['/nonexistent/dir'], io), 2);
  assert.equal(await runCli(spec, [], io), 0);
});
