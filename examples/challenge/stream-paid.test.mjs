import assert from 'node:assert/strict';
import test from 'node:test';
import {streamPaidOrders} from '../src/stream.ts';

test('paid streaming preserves export rules, backpressure, row boundaries and inputs', async () => {
  const orders = [
    {id:'1',ownerId:'a',customer:'First "quoted",\nline',total:12,status:'paid'},
    {id:'2',ownerId:'a',customer:'Pending',total:NaN,status:'pending'},
    {id:'3',ownerId:'b',customer:'Private',total:NaN,status:'paid'},
    {id:'4',ownerId:'a',customer:'Last',total:0,status:'paid'},
  ];
  const original = structuredClone(orders);
  const rows = [];
  let busy = false;
  await streamPaidOrders(orders, 'a', async row => {
    assert.equal(busy, false, 'Do not overlap emit calls');
    busy = true;
    await new Promise(resolve => setTimeout(resolve, 2));
    rows.push(row);
    busy = false;
  });
  assert.deepEqual(rows, ['id,customer,total,status', '1,"First ""quoted"",\nline",12.00,paid', '4,"Last",0.00,paid']);
  assert.deepEqual(orders, original);
  const empty = [];
  await streamPaidOrders([], 'a', async row => empty.push(row));
  assert.deepEqual(empty, ['id,customer,total,status']);
  const unauthorized = [];
  await assert.rejects(() => streamPaidOrders(orders, '', async row => unauthorized.push(row)), /ownerId/);
  assert.deepEqual(unauthorized, []);
  for (const total of [NaN, Infinity, -1]) await assert.rejects(
    () => streamPaidOrders([{...orders[0],total}], 'a', async () => {}), /Invalid total/);
  await assert.rejects(() => streamPaidOrders(orders, 'a', async () => { throw Error('sink failed'); }), /sink failed/);
});
