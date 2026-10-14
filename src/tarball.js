import { gunzipSync } from 'node:zlib';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

/** Parse a (gzipped) tar buffer. Returns [{ path, size, mode, type, data }] with the leading "package/" removed. */
export function readTar(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  const out = []; let off = 0; let pax = {}; let longName = null;
  const str = (o, n) => buf.toString('utf8', o, o + n).replace(/\0[\s\S]*$/, '');
  const num = (o, n) => { const s = str(o, n).trim(); return s ? parseInt(s, 8) : 0; };
  while (off + 512 <= buf.length) {
    if (buf.subarray(off, off + 512).every((b) => b === 0)) break;
    let name = str(off, 100); const mode = num(off + 100, 8); const size = num(off + 124, 12); const type = String.fromCharCode(buf[off + 156] || 48);
    const prefix = buf.toString('ascii', off + 257, off + 262) === 'ustar' ? str(off + 345, 155) : '';
    if (prefix) name = `${prefix}/${name}`;
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { pax = parsePax(data); continue; }
    if (type === 'g') continue;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); continue; }
    const path = (pax.path || longName || name).replace(/^[^/]+\//, '');
    pax = {}; longName = null;
    if (type === '0' || type === '\0' || type === '7') out.push({ path, size, mode, type: 'file', data: Buffer.from(data) });
    else if (type === '2') out.push({ path, size: 0, mode, type: 'symlink', data: Buffer.alloc(0) });
  }
  return out;
}
function parsePax(data) { const r = {}; let s = data.toString('utf8'); while (s.length) { const m = /^(\d+) /.exec(s); if (!m) break; const len = +m[1]; const rec = s.slice(m[0].length, len - 1); const eq = rec.indexOf('='); r[rec.slice(0, eq)] = rec.slice(eq + 1); s = s.slice(len); } return r; }

/** Run npm pack in dir into a temp folder. Returns { tarball, meta, tmp }. */
export function npmPack(dir, { runScripts = false, npm = 'npm' } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'publish-gauge-'));
  const args = ['pack', '--json', '--pack-destination', tmp, ...(runScripts ? [] : ['--ignore-scripts'])];
  const opts = { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, env: { ...process.env, npm_config_loglevel: 'error', npm_config_update_notifier: 'false', npm_config_fund: 'false' }, shell: process.platform === 'win32' };
  let stdout;
  try { stdout = execFileSync(npm, args, opts); }
  catch (e) { rmSync(tmp, { recursive: true, force: true }); let why = ''; try { const o = String(e.stdout || ''); why = JSON.parse(o.slice(o.indexOf('{'))).error?.summary || ''; } catch { /* not JSON */ }
    if (!why) why = String(e.stderr || e.message || '').split('\n').map((l) => l.replace(/^npm (ERR!|error)\s*/, '').trim()).filter((l) => l && !/complete log|_logs\/|^code /.test(l)).slice(0, 2).join(' ');
    const err = new Error(`npm pack failed: ${why || 'unknown error'}`); err.packFailed = true; throw err; }
  let meta = null; try { const j = JSON.parse(stdout.slice(stdout.indexOf('['))); meta = j[0]; } catch { /* older npm */ }
  const file = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  if (!file) { rmSync(tmp, { recursive: true, force: true }); const err = new Error('npm pack produced no tarball'); err.packFailed = true; throw err; }
  return { tarball: join(tmp, file), meta, tmp };
}

/** Write entries into a fresh directory (for load checks). */
export function extract(entries, into) {
  const dir = into || mkdtempSync(join(tmpdir(), 'publish-gauge-x-'));
  for (const e of entries) { if (e.type !== 'file' || e.path.includes('..')) continue; const p = join(dir, e.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, e.data); }
  return dir;
}
export const readTarball = (file) => readTar(readFileSync(file));
