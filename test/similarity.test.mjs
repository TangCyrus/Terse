import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWorkspace, invoke} from '../scripts/lib/workspace.mjs';
import {indexSources} from '../dist/analyze.js';
import {similarImplementations} from '../dist/similarity.js';
import {digest} from '../dist/project.js';

const original = `export function exportOrders(orders, ownerId) {
  if (!ownerId) throw new Error('ownerId is required');
  const visible = orders.filter(order => order.ownerId === ownerId);
  const rows = visible.map(order => {
    if (!Number.isFinite(order.total) || order.total < 0) throw new Error('Invalid total');
    const customer = '"' + order.customer.replaceAll('"', '""') + '"';
    return [order.id, customer, order.total.toFixed(2), order.status].join(',');
  });
  return ['id,customer,total,status', ...rows].join('\\n');
}`;
const rewritten = `export function exportPaidOrders(input, user) {
  if (user.length === 0) throw Error('ownerId is required');
  let csv = 'id,customer,total,status';
  for (const item of input) {
    if (item.ownerId !== user || item.status !== 'paid') continue;
    if (item.total < 0 || !Number.isFinite(item.total)) throw Error('Invalid total');
    const escaped = '"' + item.customer.split('"').join('""') + '"';
    csv += '\\n' + item.id + ',' + escaped + ',' + Number(item.total).toFixed(2) + ',' + item.status;
  }
  return csv;
}`;
function profiles(files) {
  const state = {files: Object.fromEntries(Object.entries(files).map(([file, content]) => [file, {content, hash: digest(content)}])),
    metadata: {}, skipped: [], hash: 'test', config: {exclude: [], minTokens: 50, minLines: 5, duplicatePolicy: 'review', verification: []}};
  const result = indexSources(state, undefined, {}, true);
  assert.deepEqual(result.errors, []);
  return result.implementations;
}
const compare = (before, after) => similarImplementations(profiles(before), profiles(after), []);

test('M3 rewritten CSV copy becomes review evidence while complete behavior verification still runs', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'terse-similarity-'));
  const root = createWorkspace(parent, 'project');
  t.after(() => {
    const resolved = fs.realpathSync(parent);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('terse-similarity-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const write = (file, text) => fs.writeFileSync(path.join(root, file), text);
  write('test/paid.test.mjs', `import assert from 'node:assert/strict';
import test from 'node:test';
import {exportPaidOrders} from '../src/paid.ts';
test('paid copy preserves behavior', () => {
  const input = [{id:'1',ownerId:'a',customer:'A "quote", name',total:12,status:'paid'},
    {id:'2',ownerId:'a',customer:'Pending',total:9,status:'pending'},
    {id:'3',ownerId:'b',customer:'Private',total:10,status:'paid'}];
  const before = structuredClone(input);
  assert.equal(exportPaidOrders(input,'a'), 'id,customer,total,status\\n1,"A ""quote"", name",12.00,paid');
  assert.throws(() => exportPaidOrders(input,''), /ownerId/);
  assert.throws(() => exportPaidOrders([{...input[0],total:NaN}],'a'), /Invalid total/);
  assert.deepEqual(input,before);
});`);
  write('terse.config.json', JSON.stringify({duplicatePolicy: 'fail', verification: [
    {command: 'node', args: ['--test', 'test/orders.test.mjs', 'test/paid.test.mjs']},
  ]}));
  const begun = invoke(root, ['begin', '--task', 'Add a paid filter without another implementation', '--query', 'exportOrders']);
  invoke(root, ['decide', '--run', begun.run, '--strategy', 'new', '--rationale', 'Record a proposed separate implementation for review.',
    '--candidate', begun.context.candidates.find(item => item.symbol === 'exportOrders').candidateId]);
  write('src/paid.ts', rewritten);
  const report = invoke(root, ['check', '--run', begun.run, '--summary'], 2);
  assert.equal(report.newDuplications, 0);
  assert.equal(report.possibleDuplications, 1);
  assert.equal(report.similarityAlgorithm, 'implementation-anchors/1');
  const finding = report.findings.find(item => item.rule === 'POSSIBLE_DUPLICATION');
  assert.equal(finding.severity, 'review'); // Strict token policy cannot turn a heuristic into failure.
  assert(finding.similarity.shared.literals.includes('id,customer,total,status'));
  assert(finding.similarity.shared.members.includes('ownerId'));
  assert(finding.similarity.shared.calls.includes('isFinite'));
  assert(finding.similarity.shared.calls.includes('toFixed'));
  assert.equal(finding.similarity.evidenceTruncated, false);
  assert.equal(finding.similarity.algorithm, report.similarityAlgorithm);
  assert.equal(Object.values(finding.similarity.shared).reduce((sum, values) => sum + values.length, 0), finding.similarity.sharedAnchors);
  assert.equal(report.verification[0].status, 'passed');
  const persisted = JSON.parse(fs.readFileSync(report.reportPath, 'utf8'));
  assert.match(persisted.verification[0].output, /tests 2\b/);
  assert.deepEqual(persisted.findings, report.findings);
  write('src/paid.ts', rewritten.replace('.toFixed(2)', '.toFixed(3)'));
  const broken = invoke(root, ['check', '--run', begun.run], 1);
  assert.equal(broken.possibleDuplications, 1);
  assert.equal(broken.verification[0].status, 'failed');
  assert(broken.findings.some(item => item.rule === 'VERIFICATION_FAILED'));
  // Replace the competing body with an actual delegation, retaining the same acceptance.
  write('src/paid.ts', "import {exportOrders} from './orders.ts';\nexport function exportPaidOrders(input,user) { return exportOrders(input.filter(item => item.status === 'paid'),user); }");
  const repaired = invoke(root, ['check', '--run', begun.run], 0);
  assert.equal(repaired.possibleDuplications, 0);
  assert.equal(repaired.verification[0].status, 'passed');
});

test('M3 anchors cover supported JS/TS formats, computed members and class methods', async t => {
  for (const extension of ['js', 'ts', 'jsx', 'tsx', 'mjs', 'mts', 'cjs', 'cts']) await t.test(extension, () => {
    const before = {[`source.${extension}`]: original};
    const current = {...before, [`paid.${extension}`]: rewritten.replaceAll('item.total', "item['total']")};
    const findings = compare(before, current);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].similarity.shared.members.filter(value => value === 'total').length, 1);
  });
  const method = rewritten.replace('export function exportPaidOrders(input, user)', 'paid(input, user)');
  assert.equal(compare({'source.ts': original}, {'source.ts': original, 'queue.ts': `export class Queue { ${method} }`})[0].locations[1].symbol, 'Queue.paid');
  const domain = text => text.replaceAll('ownerId', 'accountId').replaceAll('total', 'balance').replaceAll('customer', 'label').replaceAll('status', 'state');
  assert(compare({'invoice.ts': domain(original)}, {'invoice.ts': domain(original), 'copy.ts': domain(rewritten)})[0].similarity.shared.literals.includes('id,label,balance,state'));
  for (const extension of ['jsx', 'tsx']) {
    const jsx = text => text.replace("  let csv", "  const view = <span title=\"a different UI\" />;\n  let csv");
    assert.equal(compare({[`source.${extension}`]: original}, {[`source.${extension}`]: original, [`paid.${extension}`]: jsx(rewritten)}).length, 1);
  }
  const arrow = rewritten.replace('export function exportPaidOrders(input, user)', 'export const exportPaidOrders = (input, user) =>');
  assert.equal(compare({'source.ts': original}, {'source.ts': original, 'paid.ts': arrow}).length, 1);
  const metadata = 'const data = ' + Array.from({length: 40}, (_, index) => `meta.field${index}`).join(' + ') + ';';
  const augment = text => text.replace('{\n', '{\n' + metadata + '\n');
  const bounded = compare({}, {'source.ts': augment(original), 'paid.ts': augment(rewritten)})[0].similarity;
  assert.equal(bounded.evidenceTruncated, true);
  assert.equal(bounded.shared.members.length, 20);
  assert(bounded.sharedAnchors > Object.values(bounded.shared).reduce((sum, values) => sum + values.length, 0));
});

test('M3 similarity preserves historical pairs and moves but reports additional copies and threshold crossings', () => {
  const before = {'source.js': original, 'paid.js': rewritten};
  assert.deepEqual(compare(before, before), []);
  const moved = {'moved.js': original.replace('exportOrders', 'renamed').replace('const visible', '// Relocated\n    const visible'),
    'renamed.js': rewritten.replace('exportPaidOrders', 'other').replaceAll('\n', '\n   ')};
  assert.deepEqual(compare(before, moved), []);
  assert(compare(before, {...moved, 'third.js': rewritten}).length > 0);
  assert.deepEqual(compare({'source.js': original}, {'moved.js': original}), []);
  assert.equal(compare({}, {'source.js': original, 'paid.js': rewritten}).length, 1);
  assert.equal(compare({}, {'both.js': original + '\n' + rewritten}).length, 1);
  const unrelated = rewritten.replaceAll('id,customer,total,status', 'different format header');
  assert.equal(compare({'source.js': original, 'paid.js': unrelated}, before).length, 1);
  const expanded = Object.fromEntries(Object.entries(before).map(([file, text]) => [file, text.replace('order.total.toFixed(2)', 'order.total.toFixed(2).trim()').replace('Number(item.total).toFixed(2)', 'Number(item.total).toFixed(2).trim()')]));
  assert.equal(compare(before, expanded).length, 1);
});

test('M3 similarity does not promote generic guards, comments, wrappers or unrelated responsibilities', () => {
  const before = {'source.js': original};
  const notification = `export function enqueueNotification(pending,item) {
    if (!item.id.trim() || !item.to.trim() || !item.message.trim()) throw Error('Invalid notification');
    const existing = pending.some(entry => entry.id === item.id);
    if (existing) return [...pending];
    return [...pending, {...item}];
  }`;
  assert.deepEqual(compare(before, {...before, 'notifications.js': notification}), []);
  assert.deepEqual(compare(before, {...before, 'different.js': rewritten.replaceAll('id,customer,total,status', 'different format header')}), []);
  assert.deepEqual(compare(before, {...before, 'paid.js': '// id,customer,total,status\n' + rewritten.replaceAll('id,customer,total,status', 'different format header')}), []);
  assert.deepEqual(compare(before, {...before, 'wrapper.js': "export function paid(items,user) { return exportOrders(items.filter(item=>item.status==='paid'),user); }"}), []);
  const diagnostic = rewritten.replace("let csv = 'id,customer,total,status';", "let csv = ''; console.log('id,customer,total,status');");
  assert.deepEqual(compare(before, {...before, 'logging.js': diagnostic}), []);
  const nested = `export function wrapper() {\n${rewritten.replace('export function', 'function')}\nconst a=1; const b=2; return exportPaidOrders([], 'a'); }`;
  assert.equal(profiles({'nested.ts': nested}).length, 1); // The wrapper does not inherit its named helper's body.
  const exact = {rule: 'NEW_DUPLICATION', severity: 'review', message: 'existing token evidence', locations: [
    {path:'source.js',line:1,endLine:10}, {path:'paid.js',line:1,endLine:10},
  ]};
  assert.deepEqual(similarImplementations(profiles(before), profiles({...before,'paid.js':rewritten}), [exact]), []);
  const sameLine = profiles({'same.js': (original + '\n' + rewritten).replaceAll('\n', ' ')});
  assert.deepEqual(similarImplementations([], sameLine, [{...exact, locations: [
    {path:'same.js',line:1,endLine:1}, {path:'same.js',line:1,endLine:1},
  ]}]), []);
});

test('M3 independent authorization remains a review question rather than a claim of equivalence', () => {
  const audit = rewritten.replace('exportPaidOrders(input, user)', 'auditOrders(input, isAuditor)')
    .replace("if (user.length === 0) throw Error('ownerId is required');", "if (!isAuditor) throw Error('Auditor authorization required');")
    .replace("if (item.ownerId !== user || item.status !== 'paid') continue;", 'if (!item.ownerId) continue;');
  const finding = compare({'source.js': original}, {'source.js': original, 'audit.js': audit})[0];
  assert.equal(finding.severity, 'review');
  assert.match(finding.message, /authorization may justify both/);
  assert(!Object.hasOwn(finding, 'attribution'));
});
