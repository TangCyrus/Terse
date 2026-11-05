import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexSources, candidateId } from './analyze.js';
import { loadRun, readJson, writeJson } from './project.js';
import type { Decision } from './types.js';

export interface DecisionIssue { field: string; code: string; message: string }
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
export const strategies = ['reuse', 'modify', 'refactor', 'new'] as const;
export const dispositions = ['reuse', 'modify', 'reject'] as const;

export function validateDecision(value: unknown): { decision: Decision | null; issues: DecisionIssue[] } {
  const issues: DecisionIssue[] = [];
  const expect = (ok: unknown, field: string, message: string) => { if (!ok) issues.push({ field, code: 'invalid', message }); };
  if (!record(value)) return { decision: null, issues: [{ field: 'decision', code: 'invalid', message: 'Expected an object' }] };
  expect(strategies.includes(value.strategy), 'strategy', 'Expected reuse, modify, refactor or new');
  expect(text(value.rationale), 'rationale', 'Expected a non-empty rationale');
  expect(Array.isArray(value.considered), 'considered', 'Expected an array of candidate decisions');
  expect(Array.isArray(value.remove), 'remove', 'Expected an array of removal targets');
  if (Array.isArray(value.considered)) value.considered.forEach((item: unknown, i: number) => {
    const field = `considered[${i}]`;
    if (!record(item)) { expect(false, field, 'Expected an object'); return; }
    expect(text(item.path), `${field}.path`, 'Expected a source path');
    expect(text(item.symbol), `${field}.symbol`, 'Expected a symbol name');
    expect(dispositions.includes(item.disposition), `${field}.disposition`, 'Expected reuse, modify or reject; use disposition, not decision');
    expect(text(item.reason), `${field}.reason`, 'Expected a non-empty reason');
  });
  if (Array.isArray(value.remove)) value.remove.forEach((item: unknown, i: number) => {
    if (!record(item)) { expect(false, `remove[${i}]`, 'Expected an object'); return; }
    expect(text(item.path), `remove[${i}].path`, 'Expected a source path');
    expect(item.symbol === undefined || text(item.symbol), `remove[${i}].symbol`, 'Expected a symbol name when supplied');
  });
  return { decision: issues.length ? null : value as unknown as Decision, issues };
}

function invalid(issues: DecisionIssue[]): never {
  throw Object.assign(new Error(issues.map(issue => `${issue.field}: ${issue.message}`).join('; ')), { code: 'DECISION_INVALID', issues });
}

export interface DecisionOptions {
  input?: string; strategy?: string; rationale?: string; candidates?: string[];
  disposition?: string; reason?: string; remove?: string[];
}

export function decide(root: string, run: string, options: DecisionOptions) {
  const { dir, baseline } = loadRun(root, run);
  const index = indexSources(baseline.snapshot);
  let proposed: unknown;
  if (options.input) proposed = readJson(path.resolve(root, options.input));
  else {
    const defaultDisposition = options.strategy === 'new' ? 'reject' : options.strategy === 'reuse' ? 'reuse' : 'modify';
    const selected = [...new Set(options.candidates ?? [])].map(id => {
      const symbol = index.symbols.find(s => candidateId(s, baseline.snapshot.files[s.path].hash) === id);
      if (!symbol) invalid([{ field: 'candidate', code: 'not-found', message: `Unknown baseline candidate ID: ${id}. Run context against this run's baseline.` }]);
      return { path: symbol.path, symbol: symbol.symbol, disposition: options.disposition ?? defaultDisposition, reason: options.reason ?? options.rationale };
    });
    proposed = { strategy: options.strategy, rationale: options.rationale, considered: selected, remove: (options.remove ?? []).map(path => ({ path })) };
  }
  const { decision, issues } = validateDecision(proposed);
  if (!decision) invalid(issues);
  if (decision.strategy !== 'new' && !decision.considered.some(candidate => candidate.disposition !== 'reject')) {
    issues.push({ field: 'considered', code: 'required', message: 'Reuse, modify and refactor need an existing candidate with reuse or modify disposition' });
  }
  decision.considered.forEach((candidate, i) => {
    if (!index.symbols.some(s => s.path === candidate.path && s.symbol === candidate.symbol)) {
      issues.push({ field: `considered[${i}]`, code: 'not-found', message: 'Candidate is not present in the scanned baseline' });
    }
  });
  if (index.errors.length) issues.push({ field: 'baseline', code: 'parse-error', message: index.errors.join('; ') });
  if (issues.length) invalid(issues);
  // Do not invent or backdate retrieval evidence. Older runs without candidate IDs remain readable.
  const history = fs.existsSync(path.join(dir, 'context.json')) ? readJson(path.join(dir, 'context.json')) : [];
  if (!Array.isArray(history) || !history.some(entry => entry?.snapshotHash === baseline.snapshot.hash && Array.isArray(entry.errors) && !entry.errors.length)) {
    invalid([{ field: 'context', code: 'required', message: 'Record a successful context search against the task baseline before deciding' }]);
  }
  writeJson(dir, 'decision.json', decision);
  return { command: 'decide', run, decisionPath: path.join(dir, 'decision.json'), decision,
    next: 'Implement the change, then run check --summary --json. Saving a decision does not approve its rationale.' };
}

export function decisionGuide(root: string, run: string) {
  return { strategies, dispositions, candidateField: 'candidateId', schemaPath: fileURLToPath(new URL('../docs/decision.schema.json', import.meta.url)),
    argvTemplate: ['decide', '--cwd', root, '--run', run, '--strategy', '<strategy>', '--rationale', '<your reason>', '--candidate', '<candidateId>', '--json'],
    notes: 'Choose candidates explicitly. Reuse defaults to reuse, modify/refactor to modify, new to reject. Complex records: decide --input <file>.' };
}
