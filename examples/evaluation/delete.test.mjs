import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadOrders } from '../src/routes.ts';

test('migrated export route keeps behavior after retiring legacy implementation', () => {
  assert.equal(downloadOrders([{ id: '7', ownerId: 'team', customer: 'Legacy, client', total: 3, status: 'pending' }], 'team'),
    'id,customer,total,status\n7,"Legacy, client",3.00,pending');
  assert.throws(() => downloadOrders([], ''), /ownerId/);
});
