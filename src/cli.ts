#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { begin, rootOf } from './project.js';
import { context } from './analyze.js';
import { check } from './check.js';
import { VERSION } from './types.js';

const help = `Terse ${VERSION} — find existing code before adding another implementation

terse begin --task "<requirement>" [--cwd <project>] [--json]
terse context --run <id> --query "<behavior or symbol>" [--limit 5] [--cwd <project>] [--json]
terse check --run <id> [--skip-verification] [--cwd <project>] [--json]

After context, edit the run's decision.json, implement the change, then check.
check exit codes: 0 pass, 1 fail, 2 needs-review, 3 incomplete/error.
Verification executes the command/args configured in terse.config.json at begin.
`;

function render(result: any): string {
  if (result.command === 'begin') return `Run: ${result.run}\nTask: ${result.task}\nScanned: ${result.scannedFiles} files\nDecision: ${result.decisionPath}\nNext: ${result.next}`;
  if (result.command === 'context') {
    const rows = result.candidates.map((c: any) => `${c.path}:${c.line}  ${c.symbol}\nMatched: ${c.matched.join(', ')}\n${c.snippet}\nImported by: ${c.importedBy.map((i: any) => i.from).join(', ') || '(none resolved)'}\nTests: ${c.relatedTests.join(', ') || '(none matched)'}`);
    return [`Scanned: ${result.scannedFiles} files`, rows.length ? rows.join('\n\n') : 'No symbol candidates found. Expand the query; this does not prove no reusable code exists.',
      `File matches: ${result.fileMatches.map((f: any) => f.path).join(', ') || '(none)'}`,
      ...result.unresolvedImports.map((i: any) => `Unresolved: ${i.from}:${i.line} ${i.specifier} (${i.reason})`), ...result.errors, ...result.limitations].join('\n');
  }
  if (result.command === 'check') return [
    `Status: ${result.status}`, `Scanned: ${result.scannedFiles} files; baseline: ${result.baselineFiles}`,
    `Changes: +${result.changes.added.length} files, ~${result.changes.modified.length}, -${result.changes.deleted.length}`,
    `New duplicate matches: ${result.newDuplications} (baseline ${result.baselineClones}; current ${result.currentClones})`,
    ...result.findings.map((f: any) => `[${f.severity}] ${f.rule}: ${f.message}\n${f.locations.map((l: any) => `  ${l.path}${l.line ? `:${l.line}` : ''}${l.symbol ? `#${l.symbol}` : ''}`).join('\n')}`),
    ...result.verification.map((v: any) => `Verification ${v.status}: ${v.command.command} ${v.command.args.join(' ')}`),
    ...result.errors.map((e: string) => `Error: ${e}`),
    `Report: .terse/runs/${result.run}/report.json`,
  ].join('\n');
  return `${result.status}: ${result.errors.join('\n')}`;
}

let json = process.argv.includes('--json');
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    task: { type: 'string' }, run: { type: 'string' }, query: { type: 'string' }, cwd: { type: 'string' }, limit: { type: 'string' },
    json: { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' }, 'skip-verification': { type: 'boolean' },
  } });
  json = values.json ?? false;
  if (values.version) console.log(VERSION);
  else if (values.help || !positionals.length) console.log(help);
  else {
    const command = positionals[0];
    const permitted: Record<string, string[]> = { begin: ['task'], context: ['run', 'query', 'limit'], check: ['run', 'skip-verification'] };
    if (positionals.length !== 1 || !permitted[command]) throw new Error('Expected begin, context or check. Use --help.');
    for (const key of Object.keys(values)) if (!['cwd', 'json', ...permitted[command]].includes(key)) throw new Error(`--${key} is not valid for ${command}`);
    const root = rootOf(values.cwd ?? process.cwd());
    const required = (value: string | undefined, name: string) => { if (!value?.trim()) throw new Error(`--${name} is required`); return value; };
    let result;
    if (command === 'begin') result = begin(root, required(values.task, 'task'));
    else if (command === 'context') {
      const limit = Number(values.limit ?? 5);
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('--limit must be 1..20');
      result = context(root, required(values.run, 'run'), required(values.query, 'query'), limit);
    } else result = await check(root, required(values.run, 'run'), values['skip-verification']);
    console.log(json ? JSON.stringify(result, null, 2) : render(result));
    if ('status' in result) process.exitCode = { pass: 0, fail: 1, 'needs-review': 2, incomplete: 3 }[result.status];
    else if ('errors' in result && result.errors.length) process.exitCode = 3;
  }
} catch (error) {
  const result = { status: 'incomplete', errors: [error instanceof Error ? error.message : String(error)] };
  console.log(json ? JSON.stringify(result, null, 2) : render(result));
  process.exitCode = 3;
}
