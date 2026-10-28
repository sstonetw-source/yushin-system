'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createReceiptTransaction,MAX_READ_DOCUMENTS,MAX_READ_REQUESTS,MAX_WRITES}=require('../functions/receipt-transaction');
function fixture(read=async()=>({exists:true})){
 const calls=[],writes=[];
 const native={get:ref=>{calls.push(ref);return read(ref);},set:(...args)=>writes.push(['set',...args]),update:(...args)=>writes.push(['update',...args])};
 return {tx:createReceiptTransaction(native),calls,writes,native};
}
const exhausted={code:'failed-precondition'};
test('receipt adapter shares concurrent document reads and preserves ordered merge writes',async()=>{
 const f=fixture(),ref={path:'orders/O'},data={receivedQty:2};
 const [a,b]=await Promise.all([f.tx.get(ref),f.tx.get({path:ref.path})]);
 assert.equal(a,b);assert.equal(f.calls.length,1);
 f.tx.update(ref,data);f.tx.set({path:'receipts/R'},data,{merge:true});
 assert.equal(f.writes.length,0);f.tx.flush();
 assert.deepEqual(f.writes,[['update',ref,data],['set',{path:'receipts/R'},data,{merge:true}]]);
 assert.throws(()=>f.tx.flush());assert.throws(()=>f.tx.get(ref));assert.throws(()=>f.tx.set(ref,data));
});
test('receipt document budget includes missing documents and query results; failure leaves all staged writes untouched',async()=>{
 const f=fixture(async ref=>ref.path?{exists:false}:{docs:Array.from({length:MAX_READ_DOCUMENTS-1},()=>({}))});
 f.tx.set({path:'receipts/R'},{qty:1});await f.tx.get({path:'missing/M'});await f.tx.get({query:true});
 await assert.rejects(f.tx.get({path:'one-too-many'}),exhausted);
 assert.throws(()=>f.tx.flush(),exhausted);assert.equal(f.writes.length,0);
});
test('query request cap bounds empty repeated queries with zero writes',async()=>{
 const f=fixture(async()=>({docs:[]}));
 for(let i=0;i<MAX_READ_REQUESTS;i++)await f.tx.get({query:true});
 assert.throws(()=>f.tx.get({query:true}),exhausted);assert.equal(f.calls.length,MAX_READ_REQUESTS);
 assert.throws(()=>f.tx.flush(),exhausted);assert.equal(f.writes.length,0);
});
test('write budget includes every set and update and cannot be bypassed after catching rejection',()=>{
 for(const method of ['set','update']){
  const f=fixture();for(let i=0;i<MAX_WRITES;i++)f.tx[method]({path:'receipts/'+i},{qty:1});
  assert.throws(()=>f.tx[method]({path:'overflow'},{qty:1}),exhausted);
  assert.throws(()=>f.tx.flush(),exhausted);assert.equal(f.writes.length,0);
 }
 const f=fixture();for(let i=0;i<MAX_WRITES;i++)f.tx.set({path:'receipts/'+i},{qty:1});
 f.tx.flush();assert.equal(f.writes.length,MAX_WRITES);
});
test('transaction retries have independent counters, caches and staged writes',async()=>{
 const f=fixture(),other=createReceiptTransaction(f.native),ref={path:'orders/O'};
 await f.tx.get(ref);f.tx.set(ref,{attempt:1});await other.get(ref);other.set(ref,{attempt:2});other.flush();
 assert.equal(f.calls.length,2);assert.deepEqual(f.writes,[['set',ref,{attempt:2}]]);
});
test('failed and unfinished reads prevent any queued write from flushing',async()=>{
 const f=fixture(async()=>{throw Error('read failed');});f.tx.set({path:'receipts/R'},{qty:1});
 await assert.rejects(f.tx.get({path:'orders/O'}),/read failed/);assert.throws(()=>f.tx.flush(),exhausted);assert.equal(f.writes.length,0);
 let resolve;const g=fixture(()=>new Promise(r=>resolve=r));g.tx.set({path:'receipts/R'},{qty:1});
 const pending=g.tx.get({path:'orders/O'});await Promise.resolve();
 assert.throws(()=>g.tx.flush(),exhausted);resolve({exists:true});await pending;
 assert.throws(()=>g.tx.flush(),exhausted);assert.equal(g.writes.length,0);
});
