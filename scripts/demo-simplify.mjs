import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createWorkspace, invoke, repository} from './lib/workspace.mjs';
import {paidAcceptance, paidImplementation, paidTask} from './lib/order-task.mjs';
import {sourceMetrics} from '../dist/simplify.js';

fs.mkdirSync(path.join(repository, '.terse'), {recursive: true});
const output = fs.mkdtempSync(path.join(repository, '.terse/simplify-demo-'));
const project = createWorkspace(output, 'orders');
const source = path.join(project, 'src/orders.ts');
const original = fs.readFileSync(source, 'utf8');
const signature = 'export function exportOrders(orders: Order[], ownerId: string): string {';
const legacy = original.slice(original.indexOf(signature)).replace('function exportOrders', 'function exportLegacyOrders');
const redundant = original + '\n' + legacy;
fs.writeFileSync(source, redundant);
const compatibility = `import assert from 'node:assert/strict';
import test from 'node:test';
import {exportOrders, exportLegacyOrders} from '../src/orders.ts';
test('both public exporters keep their contracts after body consolidation', () => {
  assert.notEqual(exportOrders, exportLegacyOrders);
  assert.equal(exportLegacyOrders.name, 'exportLegacyOrders');
  assert.equal(exportLegacyOrders.length, 2);
  const input = Object.freeze([
    Object.freeze({id:'1', ownerId:'alice', customer:'A "quote"', total:12, status:'paid'}),
    Object.freeze({id:'2', ownerId:'alice', customer:'B', total:3.5, status:'pending'}),
    Object.freeze({id:'3', ownerId:'bob', customer:'Hidden', total:20, status:'paid'}),
  ]);
  for (const exporter of [exportOrders, exportLegacyOrders]) {
    assert.equal(exporter(input, 'alice'), 'id,customer,total,status\\n1,"A ""quote""",12.00,paid\\n2,"B",3.50,pending');
    assert.equal(exporter([], 'alice'), 'id,customer,total,status');
    assert.throws(() => exporter(input, ''), /ownerId/);
    for (const total of [-1, NaN, Infinity]) assert.throws(() => exporter([{...input[0], total}], 'alice'), /Invalid total/);
  }
});
`;
fs.writeFileSync(path.join(project, 'test/compatibility.test.mjs'), compatibility);
const config = JSON.parse(fs.readFileSync(path.join(project, 'terse.config.json'), 'utf8'));
config.verification = [
  {command:'node', args:['--test', 'test/*.test.mjs'], timeoutMs:30000},
  {command:'node', args:[path.join(repository, 'node_modules/typescript/bin/tsc'), '--strict', '--noEmit', '--target', 'ES2022', '--module', 'NodeNext', '--allowImportingTsExtensions', 'src/orders.ts'], timeoutMs:30000},
];
fs.writeFileSync(path.join(project, 'terse.config.json'), JSON.stringify(config));
const initialized = invoke(project, ['init']);
const run = (args, expected = 0) => invoke(project, args, expected, path.join(project, initialized.runnerArgv[1]));
const begun = run(['begin', '--task', 'Consolidate existing duplicate exporters while preserving both public entries', '--query', 'exportOrders exportLegacyOrders']);
const canonical = begun.context.candidates.find(item => item.symbol === 'exportOrders');
const target = begun.context.candidates.find(item => item.symbol === 'exportLegacyOrders');
assert(canonical && target);
const args = ['simplify', '--run', begun.run, '--candidate', target.candidateId, '--into', canonical.candidateId];
const preview = run(args, 2);
assert.equal(preview.applied, false);assert.equal(fs.readFileSync(source, 'utf8'), redundant);
run(['decide', '--run', begun.run, '--strategy', 'refactor', '--candidate', canonical.candidateId, '--candidate', target.candidateId,
  '--rationale', 'Keep both contracts, but retain only one permission, validation and CSV implementation.']);
const initial = run(begun.verificationGuide.argvTemplate);
assert.equal(initial.newDuplications, 0);assert(initial.currentClones > 0);
fs.copyFileSync(initial.reportPath, path.join(output, 'before-check.json'));
const applied = run([...args, '--apply']);
assert.equal(applied.applied, true);assert.equal(applied.simplificationVerified, true);
assert.equal(applied.report.verification.length, 2);assert(applied.report.verification.every(item => item.status === 'passed'));
const simplified = fs.readFileSync(source, 'utf8');
const repeated = run([...args, '--apply'], 3);assert.equal(repeated.diagnostics[0].causeCode, 'SIMPLIFY_STALE');
assert.equal((simplified.match(/const rows = visible.map/g) ?? []).length, 1);
assert.equal(applied.plan.metrics.matchingBodiesBefore, 2);assert.equal(applied.plan.metrics.matchingBodiesAfter, 1);
fs.writeFileSync(path.join(output, 'before.ts'), redundant);fs.writeFileSync(path.join(output, 'simplified.ts'), simplified);
fs.copyFileSync(path.join(project, '.terse/runs', begun.run, 'simplification.json'), path.join(output, 'simplification.json'));

// A new requirement starts from the already simplified project. The pair below
// is authored deterministic acceptance, not another real-agent observation.
const control = createWorkspace(output, 'patch-copy');
fs.writeFileSync(path.join(control, 'src/orders.ts'), simplified);
fs.writeFileSync(path.join(control, 'test/compatibility.test.mjs'), compatibility);
fs.writeFileSync(path.join(control, 'terse.config.json'), JSON.stringify(config));
invoke(control, ['init']);
for (const root of [project, control]) fs.appendFileSync(path.join(root, 'test/orders.test.mjs'), paidAcceptance);
const featureResults = [];
for (const [root, variant] of [[project, 'modify'], [control, 'copy']]) {
  const started = invoke(root, ['begin', '--task', paidTask, '--query', 'exportOrders']);
  const chosen = started.context.candidates.find(item => item.symbol === 'exportOrders');assert(chosen);
  invoke(root, ['decide', '--run', started.run, '--strategy', variant === 'modify' ? 'modify' : 'new', '--candidate', chosen.candidateId,
    '--rationale', variant === 'modify' ? 'Extend the sole existing exporter; keep the legacy facade delegated.' : 'Authored comparison: add a parallel paid exporter.']);
  const content = variant === 'modify' ? paidImplementation(simplified, 'reuse') : simplified.replace(signature,
    "export function exportOrders(orders: Order[], ownerId: string, status?: 'paid'): string {\n  if (status === 'paid') return exportPaidOrders(orders, ownerId);")
      + '\n' + original.slice(original.indexOf(signature)).replace('function exportOrders', 'function exportPaidOrders')
        .replace('order.ownerId === ownerId);', "order.ownerId === ownerId && order.status === 'paid');");
  fs.writeFileSync(path.join(root, 'src/orders.ts'), content);
  const checked = invoke(root, started.verificationGuide.argvTemplate, variant === 'modify' ? 0 : 2);
  assert.equal(checked.verification.length, 2);assert(checked.verification.every(item => item.status === 'passed'));
  if (variant === 'modify') {assert.equal(checked.newDuplications, 0);assert.equal(checked.possibleDuplications, 0);}
  else assert(checked.newDuplications > 0);
  featureResults.push({variant, project:root, baselineHash:checked.baselineHash, status:checked.status,
    sourceBytes:Buffer.byteLength(content), addedSourceBytes:Buffer.byteLength(content) - Buffer.byteLength(simplified),
    sourceTokens:sourceMetrics(content).tokens, addedSourceTokens:sourceMetrics(content).tokens - sourceMetrics(simplified).tokens,
    independentExportBodies:(content.match(/const rows = visible.map/g) ?? []).length,
    newDuplications:checked.newDuplications, verification:checked.verification.map(item => item.status), report:checked.reportPath});
}
assert.equal(featureResults[0].baselineHash, featureResults[1].baselineHash);
assert(featureResults[0].sourceBytes < Buffer.byteLength(redundant));
assert(featureResults[0].sourceBytes < featureResults[1].sourceBytes);
assert.equal(featureResults[0].independentExportBodies, 1);assert.equal(featureResults[1].independentExportBodies, 2);
const summary = {mode:'executable-simplification-demo', modelSessions:0, output, project,
  existing:{applied:applied.applied, verified:applied.simplificationVerified, ...applied.plan.metrics,
    verification:applied.report.verification.map(item => item.status)},
  feature:featureResults, netRemovedSourceBytes:Buffer.byteLength(redundant) - featureResults[0].sourceBytes,
  netRemovedSourceTokens:sourceMetrics(redundant).tokens - featureResults[0].sourceTokens};
assert(summary.netRemovedSourceTokens > 0);
fs.writeFileSync(path.join(output, 'comparison.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({...summary, evidence:path.join(output, 'comparison.json')}, null, 2));
