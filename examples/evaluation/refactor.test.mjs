import assert from 'node:assert/strict';
import test from 'node:test';
import { exportOrders } from '../src/orders.ts';
import { exportOrders as reportOrders } from '../src/reporting.ts';
import { downloadOrders } from '../src/routes.ts';

test('reporting module and existing public entry point preserve one contract', () => {
  const orders = [{ id: '4', ownerId: 'team', customer: 'Reorganized', total: 10, status: 'paid' }];
  const expected = 'id,customer,total,status\n4,"Reorganized",10.00,paid';
  for (const exportCsv of [exportOrders, reportOrders, downloadOrders]) {
    assert.equal(exportCsv(orders, 'team'), expected);
    assert.throws(() => exportCsv([{ ...orders[0], total: -1 }], 'team'), /Invalid total/);
  }
});
