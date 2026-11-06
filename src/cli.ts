#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { begin, rootOf } from './project.js';
import { context } from './analyze.js';
import { check } from './check.js';
import { init } from './init.js';
import { decide, decisionGuide, inputOptionIssues } from './decision.js';
import { VERSION } from './types.js';
import { resultOutput, errorOutput, summaryOutput, verificationGuide, type CliOutput, type Command, type ErrorStage } from './output.js';

const help = `Terse ${VERSION} — find existing code before adding another implementation

terse init [--verify '<command JSON>'] [--cwd <project>] [--json]
terse begin --task "<requirement>" [--query "<behavior or symbol>"] [--limit 5] [--cwd <project>] [--json]
terse context --run <id> --query "<behavior or symbol>" [--limit 5] [--cwd <project>] [--json]
terse decide --run <id> --strategy <reuse|modify|refactor|new> --rationale "<reason>" [--candidate <candidateId>] [--json]
terse decide --run <id> --input <decision.json> [--candidate <candidateId>] [--cwd <project>] [--json]
terse check --run <id> [--summary] [--skip-verification] [--cwd <project>] [--json]

Use begin --query to create a baseline and retrieve candidates in one call.
init installs the project Agent Skill and instructions, preserving existing configuration.
--verify may repeat for a new config; each value is {"command":"node","args":["--test","test/*.test.mjs"]}.
Without configured verification, init returns needs-review; configure real checks before begin.
Read candidates, then use decide to save a validated decision before implementing.
--candidate and --remove (file path) can repeat; --reason defaults to --rationale.
--disposition overrides the candidate default: reuse, modify or reject.
decide replaces the complete decision; --input supports per-candidate reasons and symbol removals.
With --input, --candidate only asserts that the baseline candidate is already in input.considered; it never appends or overrides entries.
Do not combine --input with --strategy, --rationale, --disposition, --reason or --remove; put those fields in the input file.
Use verificationGuide.argvTemplate as the final verification entry point; check runs every configured command.
Do not run the same configured tests separately by default. Begin --query already includes context.
check --summary omits full verification logs but includes bounded failureOutput excerpts; findings and saved report remain available.
check exit codes: 0 pass, 1 fail, 2 needs-review, 3 incomplete/error.
--json returns one versioned JSON object for results, help, version and errors.
Verification executes the command/args configured in terse.config.json at begin.
`;

function render(result: any): string {
  if (result.outputKind === 'error') return `${result.status}: ${result.diagnostics.map((d: any) => `[${d.code}] ${d.message}`).join('\n')}`;
  if (result.command === 'help') return result.help;
  if (result.command === 'version') return result.toolVersion;
  if (result.command === 'init') return [`Status: ${result.status}`, `Skill: ${result.skillPath}`, `Instructions: ${result.instructionsPath}`,
    ...result.files.map((file: any) => `${file.status}: ${file.path}`), ...result.setupIssues.map((issue: any) => `${issue.code}: ${issue.message}`), result.next].join('\n');
  if (result.command === 'begin') return `Run: ${result.run}\nTask: ${result.task}\nScanned: ${result.scannedFiles} files\nDecision: ${result.decisionPath}\nNext: ${result.next}${result.context ? `\n\n${render(result.context)}` : ''}`;
  if (result.command === 'decide') return `Decision saved: ${result.decisionPath}\nStrategy: ${result.decision.strategy}\nNext: ${result.next}`;
  if (result.command === 'context') {
    const rows = result.candidates.map((c: any) => `${c.path}:${c.line}  ${c.symbol}\nCandidate ID: ${c.candidateId}\nMatched: ${c.matched.join(', ')}\n${c.snippet}\nImported by: ${c.importedBy.map((i: any) => i.from).join(', ') || '(none resolved)'}\nTests: ${c.relatedTests.join(', ') || '(none matched)'}`);
    return [`Scanned: ${result.scannedFiles} files`, rows.length ? rows.join('\n\n') : 'No symbol candidates found. Expand the query; this does not prove no reusable code exists.',
      `File matches: ${result.fileMatches.map((f: any) => f.path).join(', ') || '(none)'}`,
      ...result.unresolvedImports.map((i: any) => `Unresolved: ${i.from}:${i.line} ${i.specifier} (${i.reason})`), ...result.errors, ...result.limitations].join('\n');
  }
  if (result.command === 'check') return [
    `Status: ${result.status}`, `Scanned: ${result.scannedFiles} files; baseline: ${result.baselineFiles}`,
    `Changes: +${result.changes.added.length} files, ~${result.changes.modified.length}, -${result.changes.deleted.length}`,
    `New duplicate groups: ${result.newDuplications} (baseline pairs ${result.baselineClones}; current pairs ${result.currentClones})`,
    `Possible implementation overlaps: ${result.possibleDuplications}`,
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
    strategy: { type: 'string' }, rationale: { type: 'string' }, candidate: { type: 'string', multiple: true },
    disposition: { type: 'string' }, reason: { type: 'string' }, input: { type: 'string' }, remove: { type: 'string', multiple: true }, summary: { type: 'boolean' }, verify: { type: 'string', multiple: true },
  } });
  json = values.json ?? false;
  if (values.version) { command = 'version'; output = resultOutput(command, {}); }
  else if (values.help || !positionals.length) { command = 'help'; output = resultOutput(command, { help }); }
  else {
    const permitted: Record<string, string[]> = { init: ['verify'], begin: ['task', 'query', 'limit'], context: ['run', 'query', 'limit'],
      decide: ['run', 'strategy', 'rationale', 'candidate', 'disposition', 'reason', 'input', 'remove'], check: ['run', 'skip-verification', 'summary'] };
    if (positionals.length !== 1 || !Object.hasOwn(permitted, positionals[0])) throw new Error('Expected init, begin, context, decide or check. Use --help.');
    command = positionals[0] as 'init' | 'begin' | 'context' | 'decide' | 'check';
    for (const key of Object.keys(values)) if (!['cwd', 'json', ...permitted[command]].includes(key)) throw new Error(`--${key} is not valid for ${command}`);
    const required = (value: string | undefined, name: string) => { if (!value?.trim()) throw new Error(`--${name} is required`); return value; };
    if (command === 'begin') required(values.task, 'task');
    else if (command !== 'init') required(values.run, 'run');
    const verification = values.verify?.map(value => {
      try { return JSON.parse(value); }
      catch { throw new Error('--verify must be a JSON object with command, args and optional timeoutMs'); }
    });
    const limit = Number(values.limit ?? 5);
    if (command === 'context' || (command === 'begin' && values.query !== undefined)) {
      required(values.query, 'query');
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('--limit must be 1..20');
    }
    if (command === 'begin' && values.limit !== undefined && values.query === undefined) throw new Error('--limit requires --query');
    const decisionOptions = { input: values.input, strategy: values.strategy, rationale: values.rationale,
      candidates: values.candidate, disposition: values.disposition, reason: values.reason, remove: values.remove };
    if (command === 'decide') {
      if (values.input !== undefined) {
        required(values.input, 'input');
        const issues = inputOptionIssues(decisionOptions);
        if (issues.length) throw Object.assign(new Error(issues.map(issue => issue.message).join('; ')), {issues});
      } else {
        required(values.strategy, 'strategy'); required(values.rationale, 'rationale');
        if ((values.disposition !== undefined || values.reason !== undefined) && !values.candidate?.length) throw new Error('--disposition and --reason require --candidate');
      }
    }
    stage = 'project';
    const root = rootOf(values.cwd ?? process.cwd());
    stage = 'command';
    let result;
    if (command === 'init') result = init(root, verification);
    else if (command === 'begin') {
      const started = begin(root, values.task!);
      const found = values.query !== undefined ? context(root, started.run, values.query, limit) : undefined;
      result = { ...started, decisionGuide: decisionGuide(root, started.run), ...(found ? { context: found, errors: found.errors,
        next: 'Read the context candidates, choose a strategy, then save the decision with decide.' } : {}) };
    } else if (command === 'context') result = { ...context(root, values.run!, values.query!, limit), decisionGuide: decisionGuide(root, values.run!),
      next: 'Read candidates and use their candidateId with decide. Implement after recording the decision.' };
    else if (command === 'decide') result = decide(root, values.run!, decisionOptions);
    else {
      const report = await check(root, values.run!, values['skip-verification']);
      result = values.summary ? summaryOutput(root, report) : report;
    }
    if (command !== 'check' && 'run' in result) result = {...result, verificationGuide: verificationGuide(root, values.run ?? result.run)};
    output = resultOutput(command, result);
  }
} catch (error) {
  output = errorOutput(command, stage, error);
}
console.log(json ? JSON.stringify(output, null, 2) : render(output));
process.exitCode = output.exitCode;
