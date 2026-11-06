import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createWorkspace, invoke, repository} from './lib/workspace.mjs';
import {paidTask, paidAcceptance, paidImplementation} from './lib/order-task.mjs';

fs.mkdirSync(path.join(repository, '.terse'), {recursive: true});
const output = fs.mkdtempSync(path.join(repository, '.terse/agent-demo-'));
const project = createWorkspace(output, 'orders project');
const initialized = invoke(project, ['init']);
const entryPoint = path.join(project, initialized.runnerArgv[1]);
const run = (args, expected = 0) => invoke(project, args, expected, entryPoint);
const begun = run(['begin', '--task', paidTask, '--query', '订单导出 exportOrders paid']);
const candidate = begun.context.candidates.find(item => item.path === 'src/orders.ts' && item.symbol === 'exportOrders');
assert(candidate);
const source = path.join(project, 'src/orders.ts');
const original = fs.readFileSync(source, 'utf8');
fs.appendFileSync(path.join(project, 'test/orders.test.mjs'), paidAcceptance);

// A scripted bad draft exercises feedback; this is not a new model observation.
run(['decide', '--run', begun.run, '--strategy', 'new', '--candidate', candidate.candidateId,
  '--rationale', 'Controlled bad draft: duplicate the exporter to exercise feedback.']);
fs.writeFileSync(source, paidImplementation(original, 'copy'));
const draft = run(begun.verificationGuide.argvTemplate, 2);
assert(draft.findings.some(item => item.rule === 'NEW_DUPLICATION'));
assert(draft.verification.every(item => item.status === 'passed'));
fs.copyFileSync(draft.reportPath, path.join(output, 'draft-report.json'));

run(['decide', '--run', begun.run, '--strategy', 'modify', '--candidate', candidate.candidateId,
  '--rationale', 'Add the filter to the existing exporter; keep permissions, validation and encoding shared.']);
fs.writeFileSync(source, paidImplementation(original, 'reuse'));
const final = run(begun.verificationGuide.argvTemplate);
assert.equal(final.newDuplications, 0);
assert(final.verification.length && final.verification.every(item => item.status === 'passed'));
assert.equal(final.baselineHash, draft.baselineHash);
const summary = {mode: 'scripted-integration', modelSessions: 0, task: paidTask, project, run: begun.run,
  initialization: initialized.files, candidate: {path: candidate.path, symbol: candidate.symbol},
  draft: {status: draft.status, newDuplications: draft.newDuplications, verification: draft.verification.map(item => item.status), report: path.join(output, 'draft-report.json')},
  final: {status: final.status, newDuplications: final.newDuplications, verification: final.verification.map(item => item.status), report: final.reportPath},
  sameBaseline: final.baselineHash === draft.baselineHash};
fs.writeFileSync(path.join(output, 'integration.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({...summary, evidence: path.join(output, 'integration.json')}, null, 2));
