// Shared reporting / policy / CLI core. Zero dependencies. Louis Wright, MIT.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
export const sevRank = (s) => { const i = SEVERITIES.indexOf(s); return i === -1 ? 99 : i; };
export class UsageError extends Error {}

export const POLICY_RULES = {
  'allowlist-expired': { severity: 'medium', title: 'Allowlist entry has expired' },
  'allowlist-unused': { severity: 'info', title: 'Allowlist entry matched nothing' },
};

function globRe(p) { return new RegExp('^' + String(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'); }

/** Does an allowlist entry ({rule, file, match, subject}) cover a finding? */
export function entryMatches(e, f) {
  if (e.rule && !globRe(e.rule).test(f.rule)) return false;
  if (e.file && !globRe(e.file).test(f.file || '')) return false;
  if (e.subject && !globRe(e.subject).test(f.subject || '')) return false;
  if (e.match && !String(f.message).toLowerCase().includes(String(e.match).toLowerCase())) return false;
  return !!(e.rule || e.file || e.subject || e.match);
}

export function validateConfig(config) {
  if (config == null || typeof config !== 'object' || Array.isArray(config)) throw new UsageError('config must be a JSON object');
  if (config.allowlist != null && !Array.isArray(config.allowlist)) throw new UsageError('"allowlist" must be an array');
  for (const [i, e] of (config.allowlist || []).entries()) {
    if (!e || typeof e !== 'object') throw new UsageError(`allowlist[${i}] must be an object`);
    if (!e.rule && !e.file && !e.subject && !e.match) throw new UsageError(`allowlist[${i}] needs at least one of rule, file, subject, match`);
    if (!e.reason) throw new UsageError(`allowlist[${i}] needs a "reason"`);
    if (e.expires != null && (!/^\d{4}-\d{2}-\d{2}$/.test(e.expires) || Number.isNaN(Date.parse(e.expires)))) throw new UsageError(`allowlist[${i}].expires must be YYYY-MM-DD`);
  }
  for (const [k, v] of Object.entries(config.severity || {})) if (v !== 'off' && !SEVERITIES.includes(v)) throw new UsageError(`severity.${k} must be one of ${SEVERITIES.join(', ')}, off`);
  return config;
}

/** Apply severity overrides and the allowlist. Returns { findings, suppressed }. */
export function applyPolicy(raw, config = {}, { now = new Date(), configFile = 'config' } = {}) {
  const today = now.toISOString().slice(0, 10);
  const sev = config.severity || {};
  const list = (config.allowlist || []).map((e, i) => ({ ...e, index: i, used: 0, expired: !!(e.expires && e.expires < today) }));
  const findings = []; const suppressed = [];
  for (const f0 of raw) {
    const o = sev[f0.rule];
    if (o === 'off') continue;
    const f = o ? { ...f0, severity: o } : f0;
    const hit = list.find((e) => entryMatches(e, f));
    if (hit) { hit.used++; if (!hit.expired) { suppressed.push({ ...f, reason: hit.reason, expires: hit.expires || null }); continue; } }
    findings.push(f);
  }
  for (const e of list) {
    const label = [e.rule, e.file, e.subject, e.match].filter(Boolean).join(' / ');
    if (e.expired && sev['allowlist-expired'] !== 'off') findings.push({ rule: 'allowlist-expired', severity: sev['allowlist-expired'] || 'medium', file: configFile, message: `Allowlist entry #${e.index + 1} (${label}) expired on ${e.expires}`, fix: 'Fix the underlying finding, or renew the entry with a new "expires" date and reason.' });
    else if (!e.used && sev['allowlist-unused'] !== 'off') findings.push({ rule: 'allowlist-unused', severity: sev['allowlist-unused'] || 'info', file: configFile, message: `Allowlist entry #${e.index + 1} (${label}) matched no finding`, fix: 'Remove the stale entry.' });
  }
  findings.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || String(a.file || '').localeCompare(String(b.file || '')) || (a.line || 0) - (b.line || 0));
  return { findings, suppressed };
}

export function countBy(findings) { const c = {}; for (const s of SEVERITIES) c[s] = 0; for (const f of findings) c[f.severity] = (c[f.severity] || 0) + 1; return c; }
export const exceeds = (r, failOn) => !!failOn && failOn !== 'none' && r.findings.some((f) => sevRank(f.severity) <= sevRank(failOn));

const C = { critical: '\x1b[35;1m', high: '\x1b[31;1m', medium: '\x1b[33m', low: '\x1b[36m', info: '\x1b[2m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m' };
const sumText = (counts) => SEVERITIES.filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join(', ') || 'no findings';
const loc = (f) => (f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : '');

export function formatText(r, { color = false, failOn, fixes = true } = {}) {
  const c = (k, s) => (color ? `${C[k]}${s}${C.reset}` : s);
  const l = [c('bold', `${r.tool.name} — ${r.target}`)];
  if (r.summaryLine) l.push(c('dim', r.summaryLine));
  l.push('');
  for (const f of r.findings) {
    l.push(`${c(f.severity, f.severity.toUpperCase().padEnd(8))} ${loc(f) ? c('dim', loc(f) + ' ') : ''}${f.message} [${f.rule}]`);
    if (fixes && f.fix) l.push(c('dim', `         ↳ fix: ${f.fix}`));
  }
  if (r.findings.length) l.push('');
  if (r.suppressed.length) l.push(c('dim', `${r.suppressed.length} finding(s) covered by the allowlist`));
  l.push(sumText(r.counts));
  if (failOn) l.push(exceeds(r, failOn) ? c('red', `✖ Failing (fail-on: ${failOn}).`) : c('green', `✔ Passing (fail-on: ${failOn}).`));
  return l.join('\n') + '\n';
}

export const formatJson = (r) => JSON.stringify(r, null, 2) + '\n';

const LEVEL = { critical: 'error', high: 'error', medium: 'warning', low: 'note', info: 'note' };
const SCORE = { critical: '9.0', high: '7.5', medium: '5.0', low: '3.0', info: '1.0' };
export function formatSarif(r) {
  const rules = { ...r.tool.rules, ...POLICY_RULES };
  const ids = Object.keys(rules);
  const repo = `https://github.com/MrLouisWright/${r.tool.name}`;
  return JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0',
    runs: [{
      tool: { driver: { name: r.tool.name, version: r.tool.version, informationUri: repo, rules: ids.map((id) => ({ id, name: id.replace(/(^|-)(\w)/g, (_, __, ch) => ch.toUpperCase()), shortDescription: { text: rules[id].title }, helpUri: `${repo}#rules`, defaultConfiguration: { level: LEVEL[rules[id].severity] }, properties: { 'security-severity': SCORE[rules[id].severity] } })) } },
      results: r.findings.map((f) => ({ ruleId: f.rule, ruleIndex: ids.indexOf(f.rule), level: LEVEL[f.severity], message: { text: f.fix ? `${f.message}. Fix: ${f.fix}` : f.message }, locations: [{ physicalLocation: { artifactLocation: { uri: f.file || r.tool.defaultFile || '.' }, region: { startLine: f.line || 1 } } }], partialFingerprints: { ruleSubject: `${f.rule}:${f.file || ''}:${f.subject || f.message}` }, properties: { severity: f.severity } })),
    }],
  }, null, 2) + '\n';
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
export function formatMarkdown(r, { failOn } = {}) {
  const l = [`## ${r.tool.emoji || '📏'} ${r.tool.name}`, '', `**${esc(r.target)}**: ${r.summaryLine ? esc(r.summaryLine) + '; ' : ''}${sumText(r.counts)}.`];
  if (failOn) l.push('', exceeds(r, failOn) ? `❌ Failing at \`--fail-on ${failOn}\`.` : `✅ Passing at \`--fail-on ${failOn}\`.`);
  if (r.findings.length) {
    l.push('', '| Severity | Location | Rule | Finding | Fix |', '|---|---|---|---|---|');
    for (const f of r.findings) l.push(`| ${f.severity} | ${loc(f) ? '`' + esc(loc(f)) + '`' : ''} | \`${f.rule}\` | ${esc(f.message)} | ${esc(f.fix)} |`);
  }
  if (r.suppressed.length) l.push('', `_${r.suppressed.length} finding(s) covered by the allowlist._`);
  return l.join('\n') + '\n';
}

/** Build a report object from raw findings. */
export function buildReport(tool, target, raw, config, extra = {}) {
  const { findings, suppressed } = applyPolicy(raw, config, { now: extra.now, configFile: extra.configFile });
  const { now, configFile, ...rest } = extra;
  return { tool: { name: tool.name, version: tool.version, rules: tool.rules, emoji: tool.emoji, defaultFile: tool.defaultFile }, target, ...rest, counts: countBy(findings), findings, suppressed };
}

export function loadConfig(dir, name, key, explicit) {
  const file = explicit ? resolve(explicit) : join(dir, `.${name}.json`);
  if (explicit || existsSync(file)) {
    let c; try { c = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new UsageError(`Cannot read config ${file}: ${e.message}`); }
    return { config: validateConfig(c), configFile: explicit || `.${name}.json` };
  }
  try { const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); if (pj[key]) return { config: validateConfig(pj[key]), configFile: 'package.json' }; } catch (e) { if (e instanceof UsageError) throw e; }
  return { config: {}, configFile: null };
}

const list = (v) => (v || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
export { list as splitList };

/**
 * Generic CLI. spec = { name, version, configKey, rules, help (tool-specific options text), options (parseArgs), defaultFailOn,
 *   run: async ({ dir, positionals, values, config, configFile, stdin }) => report }
 */
export async function runCli(spec, argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  const usage = (m) => { io.stderr.write(`${spec.name}: ${m}\nRun with --help for usage.\n`); return 2; };
  let a;
  try {
    a = parseArgs({ args: argv, allowPositionals: true, options: { ...spec.options, config: { type: 'string', short: 'c' }, format: { type: 'string', short: 'f' }, json: { type: 'string' }, sarif: { type: 'string' }, markdown: { type: 'string' }, 'fail-on': { type: 'string' }, 'no-color': { type: 'boolean' }, 'no-fixes': { type: 'boolean' }, 'list-rules': { type: 'boolean' }, version: { type: 'boolean', short: 'v' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) { return usage(e.message); }
  const { values: o, positionals } = a;
  const all = { ...spec.rules, ...POLICY_RULES };
  if (o.help) { io.stdout.write(`${spec.name} ${spec.version} — ${spec.tagline}\n\n${spec.usage}\n\n${spec.help}\nCommon\n  -c, --config <file>     JSON config (default: .${spec.name}.json or "${spec.configKey}" in package.json)\n  -f, --format <fmt>      text (default) | json | sarif | markdown\n      --json <file>       Also write a JSON report\n      --sarif <file>      Also write SARIF 2.1.0\n      --markdown <file>   Also write Markdown (e.g. for a job summary)\n      --fail-on <sev>     critical | high | medium | low | info | none (default: ${spec.defaultFailOn || 'high'})\n      --list-rules        Print rules and default severities\n      --no-fixes          Hide fix suggestions in text output\n      --no-color          Disable colours\n  -v, --version / -h, --help\n\nExit codes: 0 = passed, 1 = findings at or above --fail-on, 2 = usage, config or read error.\n`); return 0; }
  if (o.version) { io.stdout.write(spec.version + '\n'); return 0; }
  if (o['list-rules']) { for (const [id, r] of Object.entries(all)) io.stdout.write(`${id.padEnd(28)} ${r.severity.padEnd(9)} ${r.title}\n`); return 0; }
  const format = o.format || 'text';
  if (!['text', 'json', 'sarif', 'markdown'].includes(format)) return usage(`Invalid --format: ${format}`);
  let report; let failOn;
  try {
    const dir = resolve(spec.dirFrom ? spec.dirFrom(o, positionals) : (positionals[0] || '.'));
    if (!existsSync(dir)) return usage(`No such directory: ${dir}`);
    const { config, configFile } = loadConfig(dir, spec.name, spec.configKey, o.config);
    failOn = o['fail-on'] || config.failOn || spec.defaultFailOn || 'high';
    if (failOn !== 'none' && !SEVERITIES.includes(failOn)) return usage(`Invalid --fail-on: ${failOn}`);
    report = await spec.run({ dir, positionals, values: o, config, configFile: configFile || `.${spec.name}.json` });
  } catch (e) { if (e instanceof UsageError || e.code === 'ENOENT' || e.code === 'EACCES') return usage(e.message); throw e; }
  const color = !o['no-color'] && io.stdout.isTTY && !process.env.NO_COLOR;
  const out = { text: () => formatText(report, { color, failOn, fixes: !o['no-fixes'] }), json: () => formatJson(report), sarif: () => formatSarif(report), markdown: () => formatMarkdown(report, { failOn }) };
  io.stdout.write(out[format]());
  try {
    if (o.json) writeFileSync(o.json, formatJson(report));
    if (o.sarif) writeFileSync(o.sarif, formatSarif(report));
    if (o.markdown) writeFileSync(o.markdown, formatMarkdown(report, { failOn }));
  } catch (e) { return usage(`Cannot write output: ${e.message}`); }
  return exceeds(report, failOn) ? 1 : 0;
}

export function mainCli(spec) {
  runCli(spec).then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(`${spec.name}: ${e.stack || e}\n`); process.exitCode = 2; });
}
