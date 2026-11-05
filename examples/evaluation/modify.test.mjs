import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadOrders } from '../src/routes.ts';

test('paid export retains CSV escaping, defaults, permissions and input', () => {
  const orders = [
    { id: '1', ownerId: 'alice', customer: 'A "quoted", name', total: 12, status: 'paid' },
    { id: '2', ownerId: 'alice', customer: 'Pending', total: 20, status: 'pending' },
    { id: '3', ownerId: 'bob', customer: 'Private', total: 99, status: 'paid' },
  ];
  const original = structuredClone(orders);
  assert.equal(downloadOrders(orders, 'alice', 'paid'), 'id,customer,total,status\n1,"A ""quoted"", name",12.00,paid');
  assert.match(downloadOrders(orders, 'alice'), /Pending/);
  assert.equal(downloadOrders([], 'alice', 'paid'), 'id,customer,total,status');
  assert.throws(() => downloadOrders(orders, '', 'paid'), /ownerId/);
  assert.throws(() => downloadOrders([{ ...orders[0], total: NaN }], 'alice', 'paid'), /Invalid total/);
  assert.deepEqual(orders, original);
});
