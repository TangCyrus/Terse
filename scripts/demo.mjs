import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'dist/cli.js');
const demoRoot = path.join(root, '.terse', `demo-${Date.now()}`);
fs.mkdirSync(demoRoot, { recursive: true });

function invoke(cwd, args, expected = 0) {
  const result = spawnSync(process.execPath, [cli, ...args, '--cwd', cwd, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

const acceptance = `
test('paid filter retains permissions, validation and existing defaults', () => {
  const original = structuredClone(orders);
  const paid = exportOrders(orders, 'alice', 'paid');
  assert.equal(paid, 'id,customer,total,status\\n1,"A ""quoted"" name",12.00,paid');
  assert.deepEqual(orders, original);
  assert.equal(exportOrders([], 'alice', 'paid'), 'id,customer,total,status');
  assert.throws(() => exportOrders(orders, '', 'paid'), /ownerId/);
  assert.throws(() => exportOrders([{ ...orders[0], total: -1 }], 'alice', 'paid'), /Invalid total/);
});
`;

const results = [];
for (const variant of ['copy', 'reuse']) {
  const project = path.join(demoRoot, variant);
  fs.cpSync(path.join(root, 'examples/orders'), project, { recursive: true });
  fs.writeFileSync(path.join(project, '.gitignore'), '.terse/\n');
  execFileSync('git', ['init', '-q'], { cwd: project });
  const begin = invoke(project, ['begin', '--task', '订单导出支持付款状态筛选，同时保持权限、默认行为和 CSV 格式']);
  const context = invoke(project, ['context', '--run', begin.run, '--query', '订单导出 exportOrders paid']);
  assert(context.candidates.some(c => c.symbol === 'exportOrders'), 'Existing export function must be discoverable');
  fs.writeFileSync(begin.decisionPath, JSON.stringify({
    strategy: variant === 'reuse' ? 'modify' : 'new',
    rationale: variant === 'reuse' ? '在现有导出流程中增加筛选，复用权限检查和 CSV 编码。' : '对照组：复制现有流程增加已付款导出路径。',
    considered: [{ path: 'src/orders.ts', symbol: 'exportOrders', disposition: variant === 'reuse' ? 'modify' : 'reject',
      reason: variant === 'reuse' ? '已有流程负责权限和导出，新需求属于同一职责。' : '对照实验故意选择复制，以验证重复检测。' }],
    remove: [],
  }, null, 2));
  const sourcePath = path.join(project, 'src/orders.ts');
  const original = fs.readFileSync(sourcePath, 'utf8');
  const signature = 'export function exportOrders(orders: Order[], ownerId: string): string {';
  const extended = "export function exportOrders(orders: Order[], ownerId: string, status?: 'paid'): string {";
  let modified;
  if (variant === 'reuse') {
    modified = original.replace(signature, extended).replace('order.ownerId === ownerId);', 'order.ownerId === ownerId && (status === undefined || order.status === status));');
  } else {
    const copy = original.slice(original.indexOf(signature)).replace('exportOrders', 'exportPaidOrders')
      .replace('order.ownerId === ownerId);', "order.ownerId === ownerId && order.status === 'paid');");
    modified = original.replace(signature, `${extended}\n  if (status === 'paid') return exportPaidOrders(orders, ownerId);`) + '\n' + copy;
  }
  assert.notEqual(modified, original);
  fs.writeFileSync(sourcePath, modified);
  fs.appendFileSync(path.join(project, 'test/orders.test.mjs'), acceptance);
  const report = invoke(project, ['check', '--run', begin.run], variant === 'copy' ? 2 : 0);
  assert(report.verification.every(v => v.status === 'passed'));
  if (variant === 'copy') assert(report.newDuplications > 0);
  else assert.equal(report.newDuplications, 0);
  results.push({ variant, project, run: begin.run, retrieved: context.candidates.map(c => c.symbol), status: report.status,
    newDuplications: report.newDuplications, verification: report.verification.map(v => v.status),
    sourceLinesBefore: original.trimEnd().split('\n').length, sourceLinesAfter: modified.trimEnd().split('\n').length,
    report: path.join(project, '.terse/runs', begin.run, 'report.json') });
}
const summary = { scenario: 'Same paid-order export requirement and acceptance tests', results,
  conclusion: 'This controlled fixture demonstrates retrieval and clone detection, not a statistical improvement across autonomous agents.' };
fs.writeFileSync(path.join(demoRoot, 'comparison.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ ...summary, comparison: path.join(demoRoot, 'comparison.json') }, null, 2));
