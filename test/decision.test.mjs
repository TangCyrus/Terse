import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace, invoke } from '../scripts/lib/workspace.mjs';

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
  const invalid = p.run(['decide', '--run', begun.run, '--input', 'complex.json', '--strategy', 'new'], 3);
  assert.equal(invalid.diagnostics[0].code, 'INVALID_ARGUMENT');
  assert.equal(p.run(['begin', '--task', 'x', '--limit', '2'], 3).diagnostics[0].code, 'INVALID_ARGUMENT');
});
