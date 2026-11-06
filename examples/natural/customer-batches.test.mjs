import assert from 'node:assert/strict';
import test from 'node:test';
import {streamCustomerBatches} from '../src/reports/batches.ts';

test('customer batches preserve selection, cursor, record boundaries and delivery contracts', async () => {
  const orders=[
    {id:'1',ownerId:'a',customer:'First "quoted",\nline',total:12,status:'paid'},
    {id:'x',ownerId:'b',customer:'Private',total:NaN,status:'paid'},
    {id:'2',ownerId:'a',customer:'Pending',total:NaN,status:'pending'},
    {id:'3',ownerId:'a',customer:'Third',total:0,status:'paid'},
    {id:'4',ownerId:'a',customer:'Last',total:4.5,status:'paid'},
  ];
  const original=structuredClone(orders), batches=[];
  let busy=false;
  await streamCustomerBatches(orders,'a',{size:2,status:'paid'},async batch=>{
    assert.equal(busy,false); busy=true;
    await new Promise(resolve=>setTimeout(resolve,2)); batches.push(batch); busy=false;
  });
  assert.deepEqual(batches,[
    {csv:'id,customer,total,status\n1,"First ""quoted"",\nline",12.00,paid\n3,"Third",0.00,paid',nextCursor:'3'},
    {csv:'id,customer,total,status\n4,"Last",4.50,paid',nextCursor:null},
  ]);
  const after=[];
  await streamCustomerBatches(orders,'a',{size:1,status:'paid',afterId:'3'},async batch=>after.push(batch));
  assert.deepEqual(after,[batches[1]]);
  for(const input of [[],orders.filter(order=>order.ownerId==='b')]) {
    const empty=[]; await streamCustomerBatches(input,'a',{size:2},async batch=>empty.push(batch));
    assert.deepEqual(empty,[{csv:'id,customer,total,status',nextCursor:null}]);
  }
  for(const options of [{size:0},{size:1.5},{size:1001},{size:NaN},{size:1,status:'paid',afterId:'x'}]) {
    const delivered=[];
    await assert.rejects(()=>streamCustomerBatches(orders,'a',options,async batch=>delivered.push(batch)));
    assert.deepEqual(delivered,[]);
  }
  await assert.rejects(()=>streamCustomerBatches(orders,'',{size:1},async()=>{}),/ownerId/);
  await assert.rejects(()=>streamCustomerBatches([orders[0],orders[0]],'a',{size:1},async()=>{}),/Duplicate/i);
  for(const total of [NaN,Infinity,-1]) await assert.rejects(
    ()=>streamCustomerBatches([{...orders[0],total}],'a',{size:1},async()=>{}),/Invalid total/);
  await assert.rejects(()=>streamCustomerBatches(orders,'a',{size:1,status:'paid'},async()=>{throw Error('sink failed');}),/sink failed/);
  assert.deepEqual(orders,original);
});
