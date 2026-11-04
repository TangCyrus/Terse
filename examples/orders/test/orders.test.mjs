import assert from 'node:assert/strict';
import test from 'node:test';
import { exportOrders } from '../src/orders.ts';

const orders = [
  { id: '1', ownerId: 'alice', customer: 'A "quoted" name', total: 12, status: 'paid' },
  { id: '2', ownerId: 'alice', customer: 'Other, name', total: 20, status: 'pending' },
  { id: '3', ownerId: 'bob', customer: 'Private', total: 99, status: 'paid' },
];

test('default export preserves permissions, CSV escaping and input', () => {
  const original = structuredClone(orders);
  const csv = exportOrders(orders, 'alice');
  assert.equal(csv, 'id,customer,total,status\n1,"A ""quoted"" name",12.00,paid\n2,"Other, name",20.00,pending');
  assert.deepEqual(orders, original);
  assert.throws(() => exportOrders(orders, ''), /ownerId/);
});
