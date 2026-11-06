import assert from 'node:assert/strict';
import test from 'node:test';
import {createBillingCsv} from '../src/reports/billing.ts';
import {readArchiveCsv,weeklyDigest,downloadBilling,billingCsv} from '../src/api.ts';
import {manualDigest} from '../src/jobs/manual.ts';
import {loadBilling} from '../src/plugins.ts';

test('billing migration preserves all consumer and plugin contracts', async () => {
  const orders=[{id:'1',ownerId:'a',customer:'A "quoted",\nname',total:12,status:'paid'},
    {id:'2',ownerId:'a',customer:'Pending',total:9,status:'pending'},
    {id:'3',ownerId:'b',customer:'Private',total:20,status:'paid'}];
  const before=structuredClone(orders);
  const paid='id,customer,total,status\n1,"A ""quoted"",\nname",12.00,paid';
  const all=paid+'\n2,"Pending",9.00,pending';
  assert.equal(createBillingCsv(orders,'a'),all);
  assert.equal(createBillingCsv(orders,'a',true),paid);
  assert.equal(readArchiveCsv(orders,'a'),all);
  assert.deepEqual(weeklyDigest(orders,'a'),{kind:'weekly',csv:paid});
  assert.deepEqual(manualDigest(orders,'a'),{kind:'manual',csv:all});
  assert.equal(downloadBilling(orders,'a'),all);
  assert.equal(downloadBilling(orders,'a',true),paid);
  assert.equal(billingCsv(orders,'a'),all);
  const plugin=await loadBilling();
  assert.equal(plugin.createBillingCsv(orders,'a',true),paid);
  for(const entry of [createBillingCsv,readArchiveCsv,downloadBilling,billingCsv,plugin.createBillingCsv]) {
    assert.throws(()=>entry(orders,''),/ownerId/);
    assert.throws(()=>entry([{...orders[0],total:NaN}],'a'),/Invalid total/);
  }
  assert.deepEqual(orders,before);
});
