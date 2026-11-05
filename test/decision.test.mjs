import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { createWorkspace, invoke } from '../scripts/lib/workspace.mjs';
import {decide} from '../dist/decision.js';

function project(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-m5-'));
  const root = createWorkspace(parent, 'project');
  t.after(() => {
    const resolved = fs.realpathSync(parent);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('terse-m5-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, read: file => fs.readFileSync(path.join(root, file), 'utf8'),
    write: (file, value) => fs.writeFileSync(path.join(root, file), value),
    run: (args, code = 0) => invoke(root, args, code) };
}
const start = p => p.run(['begin', '--task', 'Modify order export without a parallel implementation', '--query', 'exportOrders']);
const selected = result => result.context.candidates.find(candidate => candidate.symbol === 'exportOrders');
const save = (p, begun, extra = []) => p.run(['decide', '--run', begun.run, '--strategy', 'modify', '--rationale', 'Keep permissions and CSV encoding in the existing function.',
  '--candidate', selected(begun).candidateId, ...extra]);

test('M5 combined begin, decide and summary check complete the workflow in three CLI calls', t => {
  const p = project(t);
  const begun = start(p);
  assert.equal(begun.schemaVersion, 1);
  assert.equal(begun.context.command, 'context');
  assert.equal(begun.context.errors.length, 0);
  assert(fs.existsSync(begun.decisionGuide.schemaPath));
  assert(begun.decisionGuide.argvTemplate.includes('--candidate'));
  assert.match(begun.next, /decide/);
  const recorded = save(p, begun, ['--candidate', selected(begun).candidateId]);
  assert.deepEqual(recorded.decision.considered, [{ path: 'src/orders.ts', symbol: 'exportOrders', disposition: 'modify', reason: recorded.decision.rationale }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(recorded.decisionPath, 'utf8')), recorded.decision);
  p.write('src/orders.ts', p.read('src/orders.ts').replace('const visible', '// Preserve the existing pipeline.\n  const visible'));
  const report = p.run(['check', '--run', begun.run, '--summary']);
  assert.equal(report.status, 'pass');
  assert.deepEqual(report.decisionIssues, []);
  assert.equal(report.verification[0].outputOmitted, true);
  assert(!Object.hasOwn(report.verification[0], 'output'));
  assert(JSON.parse(fs.readFileSync(report.reportPath, 'utf8')).verification[0].output.length > 0);
});

test('M5 decision field diagnostics reproduce the evaluated decision/disposition error without overwriting a good record', t => {
  const p = project(t);
  p.write('terse.config.json', JSON.stringify({ verification: [{ command: 'node', args: ['-e', "require('node:fs').writeFileSync('executed.txt', 'yes')"] }] }));
  const begun = start(p);
  save(p, begun);
  const previous = fs.readFileSync(begun.decisionPath, 'utf8');
  const wrong = { strategy: 'reuse', rationale: 'Use the scheduler.', considered: [{ path: 'src/orders.ts', symbol: 'exportOrders', decision: 'reuse', reason: 'Existing owner.' }], remove: [] };
  p.write('input.json', JSON.stringify(wrong));
  const rejected = p.run(['decide', '--run', begun.run, '--input', 'input.json'], 3);
  assert.equal(rejected.outputKind, 'error');
  assert.equal(rejected.diagnostics[0].causeCode, 'DECISION_INVALID');
  assert(rejected.diagnostics[0].issues.some(issue => issue.field === 'considered[0].disposition'));
  assert.equal(fs.readFileSync(begun.decisionPath, 'utf8'), previous);
  assert(!fs.existsSync(path.join(p.root, 'executed.txt')));
  // Direct edits remain supported and use the same field diagnostics in check.
  fs.writeFileSync(begun.decisionPath, JSON.stringify(wrong));
  const checked = p.run(['check', '--run', begun.run, '--skip-verification'], 2);
  assert(checked.decisionIssues.some(issue => issue.field === 'considered[0].disposition'));
  assert(checked.findings.some(finding => finding.rule === 'DECISION_MISSING'));
});

test('M5 candidate IDs are query-stable and reject changed-source IDs or missing baseline retrieval', t => {
  const p = project(t);
  const begun = start(p);
  const otherQuery = p.run(['context', '--run', begun.run, '--query', 'CSV exportOrders']);
  const id = selected(begun).candidateId;
  assert.equal(otherQuery.candidates.find(candidate => candidate.symbol === 'exportOrders').candidateId, id);
  const withoutContext = p.run(['begin', '--task', 'Do not backdate retrieval']);
  const args = ['decide', '--run', withoutContext.run, '--strategy', 'reuse', '--rationale', 'Use existing export.', '--candidate'];
  assert(p.run([...args, id], 3).diagnostics[0].issues.some(issue => issue.field === 'context'));
  p.write('src/orders.ts', '// user change\n' + p.read('src/orders.ts'));
  const afterEdit = p.run(['context', '--run', withoutContext.run, '--query', 'exportOrders']);
  const changedId = afterEdit.candidates.find(candidate => candidate.symbol === 'exportOrders').candidateId;
  assert.notEqual(changedId, id);
  assert(p.run([...args, changedId], 3).diagnostics[0].issues.some(issue => issue.field === 'candidate'));
  assert(p.run([...args, id], 3).diagnostics[0].issues.some(issue => issue.field === 'context'));
});

test('M5 new responsibilities can be recorded after an empty baseline search', t => {
  const p = project(t);
  const begun = p.run(['begin', '--task', 'Add notifications', '--query', 'enqueueNotification']);
  assert.deepEqual(begun.context.candidates, []);
  const decision = p.run(['decide', '--run', begun.run, '--strategy', 'new', '--rationale', 'No queue implementation belongs to the order export responsibility.']);
  assert.deepEqual(decision.decision.considered, []);
  assert.equal(decision.status, 'pass');
  assert.match(decision.next, /does not approve/);
});

test('M5 summary preserves failures and full persisted verification logs while reducing response size', t => {
  const p = project(t);
  const noise = 'verification-log-'.repeat(500);
  p.write('terse.config.json', JSON.stringify({ verification: [{ command: 'node', args: ['-e', "console.log('verification-log-'.repeat(500)); process.exit(1)"] }] }));
  const begun = start(p);
  save(p, begun);
  const full = p.run(['check', '--run', begun.run], 1);
  const summary = p.run(['check', '--run', begun.run, '--summary'], 1);
  assert.equal(summary.status, full.status);
  for (const key of ['findings', 'errors', 'diagnostics', 'changes', 'snapshotHash']) assert.deepEqual(summary[key], full[key]);
  assert.equal(summary.verification[0].exitCode, 1);
  assert.equal(summary.verification[0].status, 'failed');
  assert(!Object.hasOwn(summary.verification[0], 'output'));
  assert(fs.readFileSync(summary.reportPath, 'utf8').includes(noise));
  assert(Buffer.byteLength(JSON.stringify(summary)) < Buffer.byteLength(JSON.stringify(full)) / 2);
});

test('M5 combined retrieval errors remain incomplete and cannot create a successful decision', t => {
  const p = project(t);
  p.write('tsconfig.json', '{bad');
  const begun = p.run(['begin', '--task', 'Alias error', '--query', 'exportOrders'], 3);
  assert.equal(begun.outputKind, 'result');
  assert.equal(begun.status, 'incomplete');
  assert(begun.diagnostics.every(diagnostic => diagnostic.code === 'CONTEXT_INCOMPLETE'));
  assert(begun.context.errors.some(error => error.startsWith('IMPORT_CONFIG:')));
  const failed = p.run(['decide', '--run', begun.run, '--strategy', 'reuse', '--rationale', 'No successful retrieval.', '--candidate', selected(begun).candidateId], 3);
  assert(failed.diagnostics[0].issues.some(issue => issue.field === 'context'));
});

test('M5 complex input retains candidate-specific decisions and symbol removals', t => {
  const p = project(t);
  const begun = start(p);
  const decision = { strategy: 'refactor', rationale: 'Keep a compatible entry point.', considered: [
    { path: 'src/orders.ts', symbol: 'exportOrders', disposition: 'reuse', reason: 'Shared behavior.' },
    { path: 'src/orders.ts', symbol: 'Order', disposition: 'reject', reason: 'A type is not an implementation.' },
  ], remove: [{ path: 'src/orders.ts', symbol: 'obsolete' }], note: 'Legacy extension fields remain allowed.' };
  p.write('complex.json', JSON.stringify(decision));
  assert.deepEqual(p.run(['decide', '--run', begun.run, '--input', 'complex.json']).decision, decision);
  const input = p.read('complex.json');
  const asserted = p.run(['decide', '--run', begun.run, '--input', 'complex.json',
    '--candidate', selected(begun).candidateId, '--candidate', selected(begun).candidateId]);
  assert.deepEqual(asserted.decision, decision);
  assert.deepEqual(JSON.parse(p.read(path.relative(p.root, begun.decisionPath))), decision);
  assert.equal(p.read('complex.json'), input);
  const invalid = p.run(['decide', '--run', begun.run, '--input', 'complex.json', '--strategy', 'new'], 3);
  assert.equal(invalid.diagnostics[0].code, 'INVALID_ARGUMENT');
  assert.equal(p.run(['begin', '--task', 'x', '--limit', '2'], 3).diagnostics[0].code, 'INVALID_ARGUMENT');
});

test('M5 input candidate assertions cannot add entries or bypass baseline identity and record validation', t => {
  const p = project(t);
  p.write('terse.config.json', JSON.stringify({verification: [{command: 'node', args: ['-e', "require('node:fs').writeFileSync('executed.txt', 'yes')"]}]}));
  const begun = start(p);
  save(p, begun);
  const previous = p.read(path.relative(p.root, begun.decisionPath));
  const id = selected(begun).candidateId;
  const input = {strategy: 'new', rationale: 'A separate responsibility.', considered: [], remove: []};
  p.write('input.json', JSON.stringify(input));
  const attempt = candidate => p.run(['decide', '--run', begun.run, '--input', 'input.json', '--candidate', candidate], 3);
  const absent = attempt(id);
  assert.equal(absent.diagnostics[0].causeCode, 'DECISION_INVALID');
  assert(absent.diagnostics[0].issues.some(issue => issue.field === 'candidate' && issue.code === 'not-considered'));
  assert(attempt('unknown-id').diagnostics[0].issues.some(issue => issue.field === 'candidate' && issue.code === 'not-found'));
  input.considered.push({path: 'src/orders.ts', symbol: 'exportOrders', disposition: 'reuse', reason: 'Use the existing entry.'});
  p.write('input.json', JSON.stringify(input));
  p.write('src/orders.ts', '// Edited after the baseline\n' + p.read('src/orders.ts'));
  const current = p.run(['context', '--run', begun.run, '--query', 'exportOrders']).candidates.find(candidate => candidate.symbol === 'exportOrders');
  assert.notEqual(current.candidateId, id);
  assert(attempt(current.candidateId).diagnostics[0].issues.some(issue => issue.code === 'not-found'));
  input.considered[0].disposition = 'wrong';
  p.write('input.json', JSON.stringify(input));
  assert(attempt(id).diagnostics[0].issues.some(issue => issue.field === 'considered[0].disposition'));
  p.write('input.json', '{broken');
  assert.equal(attempt(id).diagnostics[0].causeCode, 'INVALID_JSON');
  assert.equal(p.read(path.relative(p.root, begun.decisionPath)), previous);
  assert(!fs.existsSync(path.join(p.root, 'executed.txt')));
});

test('M5 complex file assertions preserve rejected candidates, private removals and retrieval requirements', t => {
  const p = project(t);
  p.write('src/queue.ts', 'export class Queue { #onEvent() {} onIdle() {} }');
  const begun = p.run(['begin', '--task', 'Extract a private event waiter', '--query', 'Queue onEvent onIdle']);
  const privateId = begun.context.candidates.find(candidate => candidate.symbol === 'Queue.#onEvent').candidateId;
  const publicId = begun.context.candidates.find(candidate => candidate.symbol === 'Queue.onIdle').candidateId;
  const input = {strategy: 'refactor', rationale: 'Extract the existing wait implementation.', considered: [
    {path: 'src/queue.ts', symbol: 'Queue.#onEvent', disposition: 'modify', reason: 'Move this implementation.'},
    {path: 'src/queue.ts', symbol: 'Queue.onIdle', disposition: 'reject', reason: 'Keep this public entry point unchanged.'},
  ], remove: [{path: 'src/queue.ts', symbol: 'Queue.#onEvent'}], note: 'Keep extension fields.'};
  p.write('input.json', JSON.stringify(input));
  const recorded = p.run(['decide', '--run', begun.run, '--input', 'input.json', '--candidate', privateId, '--candidate', publicId, '--candidate', privateId]);
  assert.deepEqual(recorded.decision, input); // Assertions do not turn reject into modify or drop removals.
  const previous = p.read(path.relative(p.root, begun.decisionPath));
  input.considered[0].disposition = 'reject';
  p.write('input.json', JSON.stringify(input));
  const unsupported = p.run(['decide', '--run', begun.run, '--input', 'input.json', '--candidate', privateId], 3);
  assert(unsupported.diagnostics[0].issues.some(issue => issue.field === 'considered' && issue.code === 'required'));
  assert.equal(p.read(path.relative(p.root, begun.decisionPath)), previous);
  input.considered[0].disposition = 'modify';
  p.write('input.json', JSON.stringify(input));
  const withoutContext = p.run(['begin', '--task', 'Do not invent retrieval evidence']);
  const missing = p.run(['decide', '--run', withoutContext.run, '--input', 'input.json', '--candidate', privateId], 3);
  assert(missing.diagnostics[0].issues.some(issue => issue.field === 'context'));
});

test('M5 input conflicts identify every forbidden field before I/O and the core API refuses silent overrides', t => {
  const p = project(t);
  const begun = start(p);
  save(p, begun);
  const previous = p.read(path.relative(p.root, begun.decisionPath));
  const fields = {strategy: 'new', rationale: 'Override', disposition: 'reject', reason: 'Override', remove: 'src/legacy.ts'};
  for (const [field, value] of Object.entries(fields)) {
    const result = p.run(['decide', '--run', 'invalid-run', '--input', 'missing-input.json', '--candidate', 'not-read', `--${field}`, value], 3);
    assert.equal(result.diagnostics[0].code, 'INVALID_ARGUMENT');
    assert.equal(result.diagnostics[0].stage, 'arguments');
    assert.deepEqual(result.diagnostics[0].issues.map(issue => [issue.field, issue.code]), [[field, 'conflict']]);
    assert.throws(() => decide(p.root, begun.run, {input: 'missing-input.json', [field]: field === 'remove' ? [value] : value}),
      error => error.code === 'DECISION_INVALID' && error.issues.some(issue => issue.field === field && issue.code === 'conflict'));
  }
  const multiple = p.run(['decide', '--run', begun.run, '--input', 'missing-input.json', '--strategy', 'new', '--rationale', 'Override'], 3);
  assert.deepEqual(multiple.diagnostics[0].issues.map(issue => issue.field), ['strategy', 'rationale']);
  assert.equal(p.read(path.relative(p.root, begun.decisionPath)), previous);
});

test('M5 complex input guide is directly executable without adding selection flags', t => {
  const p = project(t);
  const begun = start(p);
  const input = {strategy: 'modify', rationale: 'Use the existing pipeline.', considered: [
    {path: 'src/orders.ts', symbol: 'exportOrders', disposition: 'modify', reason: 'Existing responsibility.'},
  ], remove: []};
  p.write('input.json', JSON.stringify(input));
  const guide = begun.decisionGuide;
  assert.equal(guide.inputCandidateRole, 'assertion');
  assert.deepEqual(guide.inputExclusiveFlags, ['--strategy', '--rationale', '--disposition', '--reason', '--remove']);
  assert(!guide.inputArgvTemplate.includes('--candidate'));
  const args = guide.inputArgvTemplate.map(value => value === '<decision.json>' ? 'input.json' : value);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), ...args], {cwd: p.root, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout).decision, input);
});
