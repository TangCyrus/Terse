import assert from 'node:assert/strict';
import test from 'node:test';
import { exportAuditOrders } from '../src/audit.ts';
import { exportOrders } from '../src/orders.ts';

test('audit export has a separate authorization and visibility contract', () => {
  const orders = [
    { id: '1', ownerId: 'alice', customer: 'First', total: 1, status: 'paid' },
    { id: '2', ownerId: 'bob', customer: 'Second', total: 2, status: 'pending' },
  ];
  assert.match(exportAuditOrders(orders, true), /Second/);
  assert.doesNotMatch(exportOrders(orders, 'alice'), /Second/);
  assert.throws(() => exportAuditOrders(orders, false), /auditor/);
  assert.throws(() => exportAuditOrders([{ ...orders[0], total: -1 }], true), /Invalid total/);
});
