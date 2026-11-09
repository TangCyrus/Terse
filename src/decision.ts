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

const inputExclusiveFlags = ['strategy', 'rationale', 'disposition', 'reason', 'remove'] as const;
export function inputOptionIssues(options: DecisionOptions): DecisionIssue[] {
  return options.input === undefined ? [] : inputExclusiveFlags.filter(field => options[field] !== undefined).map(field => ({
    field, code: 'conflict', message: `--${field} cannot be combined with --input; put this decision field in the input file. Only --candidate may accompany --input as a baseline assertion.`,
  }));
}

export function decide(root: string, run: string, options: DecisionOptions) {
  const conflicts = inputOptionIssues(options);
  if (conflicts.length) invalid(conflicts);
  const { dir, baseline } = loadRun(root, run);
  const index = indexSources(baseline.snapshot);
  const selected = [...new Set(options.candidates ?? [])].map(id => {
    const symbol = index.symbols.find(s => candidateId(s, baseline.snapshot.files[s.path].hash) === id);
    if (!symbol) invalid([{ field: 'candidate', code: 'not-found', message: `Unknown baseline candidate ID: ${id}. Run context against this run's baseline.` }]);
    return symbol;
  });
  let proposed: unknown;
  if (options.input !== undefined) proposed = readJson(path.resolve(root, options.input));
  else {
    const defaultDisposition = options.strategy === 'new' ? 'reject' : options.strategy === 'reuse' ? 'reuse' : 'modify';
    proposed = { strategy: options.strategy, rationale: options.rationale,
      considered: selected.map(symbol => ({ path: symbol.path, symbol: symbol.symbol, disposition: options.disposition ?? defaultDisposition, reason: options.reason ?? options.rationale })),
      remove: (options.remove ?? []).map(path => ({ path })) };
  }
  const { decision, issues } = validateDecision(proposed);
  if (!decision) invalid(issues);
  if (options.input !== undefined) for (const symbol of selected) {
    if (!decision.considered.some(candidate => candidate.path === symbol.path && candidate.symbol === symbol.symbol)) {
      issues.push({field: 'candidate', code: 'not-considered',
        message: `Baseline candidate ${symbol.path}#${symbol.symbol} is absent from input.considered. Add the intended entry to the input or remove --candidate; candidates are not appended automatically.`});
    }
  }
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
    inputArgvTemplate: ['decide', '--cwd', root, '--run', run, '--input', '<decision.json>', '--json'],
    inputCandidateRole: 'assertion', inputExclusiveFlags: inputExclusiveFlags.map(flag => `--${flag}`),
    removalGuide: { file: { path: '<baseline source path>' }, symbol: { path: '<baseline source path>', symbol: '<exact baseline symbol, e.g. PQueue.#onEvent>' },
      notes: 'Declare files and indexed declarations you will remove or move in decision.remove before editing. In-place refactors may keep remove empty. --remove declares whole files; symbol removals use the complete --input decision. Check fails with REMOVAL_DECLARATION_MISSING and undeclaredRemovals for observed omissions, regardless of strategy. Amend the same run, preserve existing considered/remove entries, and rerun full check; declaring a target does not resolve M4 reference uncertainty.' },
    notes: 'Choose candidates explicitly. Reuse defaults to reuse, modify/refactor to modify, new to reject. Complex records use inputArgvTemplate: the file is the complete decision. Optional --candidate IDs assert existing input.considered entries; they never append candidates or override dispositions, reasons or removals.' };
}
