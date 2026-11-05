#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { begin, rootOf } from './project.js';
import { context } from './analyze.js';
import { check } from './check.js';
import { VERSION } from './types.js';
import { resultOutput, errorOutput, type CliOutput, type Command, type ErrorStage } from './output.js';

const help = `Terse ${VERSION} — find existing code before adding another implementation

terse begin --task "<requirement>" [--cwd <project>] [--json]
terse context --run <id> --query "<behavior or symbol>" [--limit 5] [--cwd <project>] [--json]
terse check --run <id> [--skip-verification] [--cwd <project>] [--json]

After context, edit the run's decision.json, implement the change, then check.
check exit codes: 0 pass, 1 fail, 2 needs-review, 3 incomplete/error.
--json returns one versioned JSON object for results, help, version and errors.
Verification executes the command/args configured in terse.config.json at begin.
`;

function render(result: any): string {
  if (result.outputKind === 'error') return `${result.status}: ${result.diagnostics.map((d: any) => `[${d.code}] ${d.message}`).join('\n')}`;
  if (result.command === 'help') return result.help;
  if (result.command === 'version') return result.toolVersion;
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
let command: Command | null = null;
let stage: ErrorStage = 'arguments';
let output: CliOutput;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    task: { type: 'string' }, run: { type: 'string' }, query: { type: 'string' }, cwd: { type: 'string' }, limit: { type: 'string' },
    json: { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' }, 'skip-verification': { type: 'boolean' },
  } });
  json = values.json ?? false;
  if (values.version) { command = 'version'; output = resultOutput(command, {}); }
  else if (values.help || !positionals.length) { command = 'help'; output = resultOutput(command, { help }); }
  else {
    const permitted: Record<string, string[]> = { begin: ['task'], context: ['run', 'query', 'limit'], check: ['run', 'skip-verification'] };
    if (positionals.length !== 1 || !Object.hasOwn(permitted, positionals[0])) throw new Error('Expected begin, context or check. Use --help.');
    command = positionals[0] as 'begin' | 'context' | 'check';
    for (const key of Object.keys(values)) if (!['cwd', 'json', ...permitted[command]].includes(key)) throw new Error(`--${key} is not valid for ${command}`);
    const required = (value: string | undefined, name: string) => { if (!value?.trim()) throw new Error(`--${name} is required`); return value; };
    if (command === 'begin') required(values.task, 'task');
    else required(values.run, 'run');
    const limit = Number(values.limit ?? 5);
    if (command === 'context') {
      required(values.query, 'query');
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('--limit must be 1..20');
    }
    stage = 'project';
    const root = rootOf(values.cwd ?? process.cwd());
    stage = 'command';
    let result;
    if (command === 'begin') result = begin(root, values.task!);
    else if (command === 'context') result = context(root, values.run!, values.query!, limit);
    else result = await check(root, values.run!, values['skip-verification']);
    output = resultOutput(command, result);
  }
} catch (error) {
  output = errorOutput(command, stage, error);
}
console.log(json ? JSON.stringify(output, null, 2) : render(output));
process.exitCode = output.exitCode;
