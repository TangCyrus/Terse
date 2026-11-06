import assert from 'node:assert/strict';
import test from 'node:test';
import {streamAuditCsv} from '../src/reports/audit.ts';
import {exportOrders} from '../src/orders.ts';

test('audit delivery has independent strict authorization and shared record rules', async () => {
  const orders=[{id:'1',ownerId:'a',customer:'First "quoted",\nname',total:12,status:'paid'},
    {id:'2',ownerId:'bo"b\nteam',customer:'Second',total:0,status:'pending'}];
  const original=structuredClone(orders), authorization={auditor:true}, rows=[];
  let busy=false;
  await streamAuditCsv(orders,authorization,async row=>{
    assert.equal(busy,false); busy=true;
    await new Promise(resolve=>setTimeout(resolve,2)); rows.push(row); busy=false;
  });
  assert.deepEqual(rows,['ownerId,id,customer,total,status','"a",1,"First ""quoted"",\nname",12.00,paid','"bo""b\nteam",2,"Second",0.00,pending']);
  for(const filter of [{owners:['a']},{statuses:['paid']}]) {
    const selected=[]; await streamAuditCsv(orders,{auditor:true,...filter},async row=>selected.push(row));
    assert.deepEqual(selected,rows.slice(0,2));
  }
  for(const filter of [{owners:[]},{statuses:[]}]) {
    const selected=[]; await streamAuditCsv(orders,{auditor:true,...filter},async row=>selected.push(row));
    assert.deepEqual(selected,[rows[0]]);
  }
  for(const auditor of [false,'true',1,null,undefined]) {
    const emitted=[];
    await assert.rejects(()=>streamAuditCsv(orders,{auditor},async row=>emitted.push(row)));
    assert.deepEqual(emitted,[]);
  }
  for(const total of [NaN,Infinity,-1]) await assert.rejects(
    ()=>streamAuditCsv([{...orders[0],total}],authorization,async()=>{}),/Invalid total/);
  await assert.rejects(()=>streamAuditCsv(orders,authorization,async()=>{throw Error('sink failed');}),/sink failed/);
  assert.equal(exportOrders(orders,'a'),'id,customer,total,status\n1,"First ""quoted"",\nname",12.00,paid');
  assert.throws(()=>exportOrders(orders,''),/ownerId/);
  assert.deepEqual(orders,original);
  assert.deepEqual(authorization,{auditor:true});
});
