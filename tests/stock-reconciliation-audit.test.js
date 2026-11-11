'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {reconcileStockRows,auditStockReconciliation}=require('../functions/stock-reconciliation-audit');
const {readArguments}=require('../functions/scripts/audit-stock-reconciliation');
const rows=()=>({inventory:[{id:'P',data:{productKey:'P',onHand:8,reserved:3,incoming:2,
 transferInTransit:3,transferFreeInTransit:1,transferReserved:1}}],
 warehouses:[{id:'W__P',data:{productKey:'P',warehouseId:'W',onHand:5,reserved:1,incoming:2,
 transferReserved:1}}]});
test('legal branch-to-main transit remains company-owned but unavailable to allocate',()=>{
 assert.equal(reconcileStockRows(...Object.values(rows())).status,'CONSISTENT');
});
test('reject mismatched warehouse sums, bad identity, unsupported transit and orphan stocks',()=>{
 const corruptions=[f=>f.inventory[0].data.onHand=9,f=>f.inventory[0].data.reserved=4,
  f=>f.warehouses[0].data.incoming=1,f=>f.warehouses[0].data.transferReserved=0,
  f=>f.warehouses[0].id='bad',f=>f.warehouses[0].data.transferFreeInTransit=1,
  f=>f.inventory.splice(0,1),f=>f.warehouses[0].data.reserved=-1];
 for(const change of corruptions){const f=rows();change(f);assert.equal(reconcileStockRows(f.inventory,f.warehouses).status,'MISMATCH');}
});
test('the audit reads both collections within a read-only transaction and fails closed on truncation',async()=>{
 const f=rows(),before=structuredClone(f),db={
  collection(name){return {limit(n){assert.equal(n,1001);return name;}};},
  runTransaction(callback,options){assert.deepEqual(options,{readOnly:true});return callback({
   get:async name=>{const collection=name==='warehouseStocks'?'warehouses':name;
    return {size:f[collection].length,docs:f[collection].map(row=>({id:row.id,data:()=>row.data}))};},
   create(){throw Error('write forbidden');},set(){throw Error('write forbidden');},update(){throw Error('write forbidden');}
  });}
 };
 assert.equal((await auditStockReconciliation(db)).status,'CONSISTENT');assert.deepEqual(f,before);
 f.warehouses=Array.from({length:1001},(_,i)=>({id:'W'+i+'__P',data:{productKey:'P',warehouseId:'W'+i}}));
 assert.equal((await auditStockReconciliation(db)).status,'INCONCLUSIVE');
});
test('CLI requires explicit project and rejects emulator and extra write-shaped arguments',()=>{
 assert.deepEqual(readArguments(['--project=yu-shing-company'],{}),{project:'yu-shing-company'});
 for(const args of [[],['--project=other'],['--project=yu-shing-company','--execute']])
  assert.throws(()=>readArguments(args,{}));
 assert.throws(()=>readArguments(['--project=yu-shing-company'],{FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}));
});
