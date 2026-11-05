import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadOrders } from '../src/routes.ts';

test('application route keeps owner isolation and validation', () => {
  const orders = [
    { id: '1', ownerId: 'alice', customer: 'Visible', total: 2, status: 'paid' },
    { id: '2', ownerId: 'bob', customer: 'Private', total: 9, status: 'pending' },
  ];
  assert.match(downloadOrders(orders, 'alice'), /Visible/);
  assert.doesNotMatch(downloadOrders(orders, 'alice'), /Private/);
  assert.throws(() => downloadOrders(orders, ''), /ownerId/);
});
