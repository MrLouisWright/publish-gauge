export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export interface Finding { rule: string; severity: Severity; message: string; fix?: string; file?: string; line?: number; subject?: string; [k: string]: unknown }
export interface AllowlistEntry { rule?: string; file?: string; subject?: string; match?: string; reason: string; expires?: string }
export interface Config { failOn?: Severity | 'none'; allowlist?: AllowlistEntry[]; severity?: Record<string, Severity | 'off'>; [k: string]: unknown }
export interface Rule { severity: Severity; title: string }
export interface Report { tool: { name: string; version: string; rules: Record<string, Rule> }; target: string; summaryLine?: string; counts: Record<Severity, number>; findings: Finding[]; suppressed: (Finding & { reason: string; expires: string | null })[]; [k: string]: unknown }
export const SEVERITIES: Severity[];
export const POLICY_RULES: Record<string, Rule>;
export class UsageError extends Error {}
export function applyPolicy(raw: Finding[], config?: Config, opts?: { now?: Date; configFile?: string }): { findings: Finding[]; suppressed: Report['suppressed'] };
export function validateConfig(config: unknown): Config;
export function exceeds(report: Report, failOn: Severity | 'none'): boolean;
export function formatText(report: Report, opts?: { color?: boolean; failOn?: string; fixes?: boolean }): string;
export function formatJson(report: Report): string;
export function formatSarif(report: Report): string;
export function formatMarkdown(report: Report, opts?: { failOn?: string }): string;
