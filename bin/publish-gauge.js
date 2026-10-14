#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { mainCli, check, RULES, splitList } from '../src/index.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
mainCli({
  name: 'publish-gauge', version: pkg.version, configKey: 'publishGauge', rules: RULES,
  tagline: 'check what npm publish will ship before you publish',
  usage: 'Usage: publish-gauge [dir] [options]',
  help: `Checks
      --tarball <file.tgz>      Check an existing tarball instead of running npm pack
      --run-scripts             Run prepack/prepare scripts while packing (default: --ignore-scripts)
      --max-size <size>         Packed size budget, e.g. 500kb, 2mb
      --max-unpacked-size <s>   Unpacked size budget
      --max-file-size <size>    Per-file budget (default 1mb)
      --no-load                 Do not load-test entry points
      --allow-private           Do not report "private": true
      --ignore-files <globs>    Files to skip in content checks (comma-separated)
`,
  options: { tarball: { type: 'string' }, 'run-scripts': { type: 'boolean' }, 'max-size': { type: 'string' }, 'max-unpacked-size': { type: 'string' }, 'max-file-size': { type: 'string' }, 'no-load': { type: 'boolean' }, 'allow-private': { type: 'boolean' }, 'ignore-files': { type: 'string', multiple: true } },
  run: async ({ dir, values: o, config, configFile }) => check(dir, { tarball: o.tarball, runScripts: o['run-scripts'] || undefined, maxSize: o['max-size'], maxUnpackedSize: o['max-unpacked-size'], maxFileSize: o['max-file-size'], noLoad: o['no-load'] || undefined, allowPrivate: o['allow-private'] || undefined, ignoreFiles: splitList(o['ignore-files']), toolVersion: pkg.version }, config, configFile),
});
