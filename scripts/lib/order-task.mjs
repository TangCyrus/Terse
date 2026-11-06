export const paidTask = '订单导出支持付款状态筛选，同时保持权限、默认行为和 CSV 格式';

export const paidAcceptance = `
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

export function paidImplementation(original, variant) {
  const signature = 'export function exportOrders(orders: Order[], ownerId: string): string {';
  const extended = "export function exportOrders(orders: Order[], ownerId: string, status?: 'paid'): string {";
  if (variant === 'reuse') return original.replace(signature, extended)
    .replace('order.ownerId === ownerId);', 'order.ownerId === ownerId && (status === undefined || order.status === status));');
  if (variant !== 'copy') throw Error(`Unknown order task variant: ${variant}`);
  const copy = original.slice(original.indexOf(signature)).replace('exportOrders', 'exportPaidOrders')
    .replace('order.ownerId === ownerId);', "order.ownerId === ownerId && order.status === 'paid');");
  return original.replace(signature, `${extended}\n  if (status === 'paid') return exportPaidOrders(orders, ownerId);`) + '\n' + copy;
}
