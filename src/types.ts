export const VERSION = '0.1.0';
export const ANALYZER = 'terse/0.1.0 typescript/5.9.3 jscpd-core/4.2.5 tokenizer/4.2.6';
export type Status = 'pass' | 'needs-review' | 'fail' | 'incomplete';
export interface VerificationCommand { command: string; args: string[]; timeoutMs: number }
export interface Config {
  exclude: string[];
  minTokens: number;
  minLines: number;
  duplicatePolicy: 'review' | 'fail';
  verification: VerificationCommand[];
}
export interface Source { content: string; hash: string }
export interface Snapshot {
  files: Record<string, Source>;
  metadata: Record<string, string>;
  hash: string;
  skipped: { path: string; reason: string }[];
  config: Config;
}
export interface Baseline {
  schema: 1; analyzer: string; run: string; root: string;
  task: string; createdAt: string; head: string | null; snapshot: Snapshot;
}
export interface Location { path: string; symbol: string; line: number; endLine: number }
export interface SymbolInfo extends Location { text: string; signature: string }
export interface Decision {
  strategy: 'reuse' | 'modify' | 'refactor' | 'new';
  rationale: string;
  considered: { path: string; symbol: string; disposition: 'reuse' | 'modify' | 'reject'; reason: string }[];
  remove: { path: string; symbol?: string }[];
}
export interface Finding {
  rule: string; severity: 'review' | 'fail'; message: string;
  locations: { path: string; line?: number; endLine?: number; symbol?: string }[];
}
export interface VerificationResult {
  command: VerificationCommand; exitCode: number | null;
  status: 'passed' | 'failed' | 'error'; output: string; error?: string;
}
