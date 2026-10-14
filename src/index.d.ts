import type { Report, Rule } from './core.js';
export * from './core.js';

export interface PublishGaugeOptions {
  /** Check this .tgz instead of running npm pack. */
  tarball?: string;
  /** Run prepack/prepare scripts while packing (default false: --ignore-scripts). */
  runScripts?: boolean;
  /** Packed size budget in bytes or as "500kb" / "2mb". */
  maxSize?: number | string;
  maxUnpackedSize?: number | string;
  maxFileSize?: number | string;
  /** Skip load-testing entry points. */
  noLoad?: boolean;
  allowPrivate?: boolean;
  /** Globs of files to skip in content checks. */
  ignoreFiles?: string[];
  /** Include the full file list in report.info.fileList. */
  listFiles?: boolean;
  now?: Date;
  toolVersion?: string;
  /** npm executable (default "npm"). */
  npm?: string;
}
export interface TarEntry { path: string; size: number; mode: number; type: 'file' | 'symlink'; data: Buffer }
export declare const RULES: Record<string, Rule>;
export declare function check(dir: string, opts?: PublishGaugeOptions, config?: Record<string, unknown>, configFile?: string): Report;
export declare function analyze(dir: string, opts?: Record<string, unknown>): { pkg: Record<string, unknown>; info: Record<string, unknown>; findings: Report['findings'] };
export declare function exportTargets(exports: unknown): { path: string; subpath: string; conditions: string[] }[];
export declare function parseSize(v: string | number | null | undefined): number | null;
export declare function fmtSize(bytes: number): string;
export declare function readTar(buf: Buffer): TarEntry[];
export declare function readTarball(file: string): TarEntry[];
export declare function npmPack(dir: string, opts?: { runScripts?: boolean; npm?: string }): { tarball: string; meta: Record<string, unknown> | null; tmp: string };
export declare function extract(entries: TarEntry[], into?: string): string;
