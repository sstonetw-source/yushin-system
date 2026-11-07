'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {initializeTestEnvironment}=require('@firebase/rules-unit-testing');
const source=fs.readFileSync('src/features/products/product-master-import.js','utf8');
let env;
test.before(async()=>{
 assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^(127\.0\.0\.1|localhost):\d+$/,'Only local Emulator is allowed');
 env=await initializeTestEnvironment({projectId:'demo-yushin-import',firestore:{rules:fs.readFileSync('firestore.rules','utf8')}});
 await env.withSecurityRulesDisabled(async c=>{
  const db=c.firestore();for(const role of ['admin','purchaser','sales','warehouse','engineer'])await db.collection('users').doc('import-'+role).set({role,active:true});
 });
});
test.after(async()=>{await env?.cleanup();});
function harness(role='admin'){
 const db=env.authenticatedContext('import-'+role).firestore();
 const metrics={reads:0,writes:0,transactions:0};let beforeCommit=async()=>{};
 const c=vm.createContext({currentUserRole:'admin',currentUser:{uid:'import-'+role},db:{
  runTransaction:async action=>{metrics.transactions++;const committed=await db.runTransaction(async tx=>{
   let writes=0;const result=await action({get:async ref=>{metrics.reads++;return tx.get(ref);},set:(...args)=>{writes++;tx.set(...args);}});
   await beforeCommit();return {result,writes};
  });metrics.writes+=committed.writes;return committed.result;}
 }});
 vm.runInContext(source.slice(source.indexOf('async function commitMigrationBatch('),source.indexOf('async function readCollectionInBatches(')),c);
 vm.runInContext(source.slice(source.indexOf('function productImportOperation('),source.indexOf('async function loadExistingProductImportState(')),c);
 return {db,c,metrics,set beforeCommit(fn){beforeCommit=fn;},op:(name,id,patch,expected)=>c.productImportOperation([{ref:db.collection(name).doc(id),patch,expected}])};
}
async function seed(name,id,value){await env.withSecurityRulesDisabled(c=>c.firestore().collection(name).doc(id).set(value));}
async function read(name,id){let data;await env.withSecurityRulesDisabled(async c=>{data=(await c.firestore().collection(name).doc(id).get()).data();});return data;}
test('real transaction writes product and cost atomically, then skips already-applied values',async()=>{
 const h=harness();const id='import-atomic';
 await seed('products',id,{productName:'old',listPrice:100});await seed('productCosts',id,{standardCost:20});
 const checks=[h.op('products',id,{productName:'new'},{productName:'old'}),h.op('productCosts',id,{standardCost:30},{standardCost:20})];
 await h.c.commitMigrationBatch(checks,100);assert.equal(h.metrics.reads,2);assert.equal(h.metrics.writes,2);assert.equal(h.metrics.transactions,1);
 await h.c.commitMigrationBatch(checks,100);assert.equal(h.metrics.reads,4);assert.equal(h.metrics.writes,2);
 assert.equal((await read('products',id)).listPrice,100);assert.equal((await read('productCosts',id)).standardCost,30);
});
test('preview conflicts reject product and cost together; unrelated newer fields are preserved',async()=>{
 const h=harness();const id='import-conflict';await seed('products',id,{productName:'staff edit',listPrice:200});await seed('productCosts',id,{standardCost:20});
 await assert.rejects(h.c.commitMigrationBatch([h.op('products',id,{productName:'excel'},{productName:'old'}),h.op('productCosts',id,{standardCost:30},{standardCost:20})],100),/其他操作修改/);
 assert.equal((await read('productCosts',id)).standardCost,20);
 await h.c.commitMigrationBatch([h.op('products',id,{listPrice:250},{listPrice:200})],100);
 assert.equal((await read('products',id)).productName,'staff edit');
});
test('Firestore retries a concurrent change and refuses to overwrite the new price',async()=>{
 const h=harness();const id='import-retry';await seed('products',id,{listPrice:100});let once=true;
 h.beforeCommit=async()=>{if(once){once=false;await seed('products',id,{listPrice:130});}};
 await assert.rejects(h.c.commitMigrationBatch([h.op('products',id,{listPrice:150},{listPrice:100})],100),/其他操作修改/);
 assert.ok(h.metrics.reads>=2);assert.equal((await read('products',id)).listPrice,130);
});
test('server rules reject sales, warehouse and engineer despite forged frontend admin role',async()=>{
 for(const role of ['sales','warehouse','engineer']){
  const h=harness(role);const id='import-denied-'+role;await seed('products',id,{listPrice:100});await seed('productCosts',id,{standardCost:20});
  for(const [name,patch,expected] of [['products',{listPrice:150},{listPrice:100}],['productCosts',{standardCost:30},{standardCost:20}]]){
   await assert.rejects(h.c.commitMigrationBatch([h.op(name,id,patch,expected)],100),e=>e.code==='permission-denied');
  }
  assert.equal((await read('products',id)).listPrice,100);assert.equal((await read('productCosts',id)).standardCost,20);
 }
 const buyer=harness('purchaser');await buyer.c.commitMigrationBatch([buyer.op('productCosts','import-buyer',{standardCost:1},undefined)],100);
 assert.equal((await read('productCosts','import-buyer')).standardCost,1);
});
test('partial completion reports acknowledged rows; rerun skips the successful chunk',async()=>{
 const h=harness();const id='import-partial';await seed('products',id,{listPrice:100});await seed('productCosts',id,{standardCost:25});
 const ops=[h.op('products',id,{listPrice:150},{listPrice:100}),h.op('productCosts',id,{standardCost:30},{standardCost:20})];
 await assert.rejects(h.c.commitMigrationBatch(ops,1),e=>e.committedOperations===1&&e.totalOperations===2);
 assert.equal((await read('products',id)).listPrice,150);
 const writes=h.metrics.writes;ops[1]=h.op('productCosts',id,{standardCost:30},{standardCost:25});
 await h.c.commitMigrationBatch(ops,1);assert.equal(h.metrics.writes-writes,1);
});

test('import source remains a persisted change, not a discarded audit-only patch',async()=>{
 const h=harness();const id='import-source';await seed('products',id,{source:'MANUAL',listPrice:100});
 await h.c.commitMigrationBatch([h.op('products',id,{source:'PRODUCT_IMPORT',updatedAt:'now'},{source:'MANUAL'})],100);
 assert.equal((await read('products',id)).source,'PRODUCT_IMPORT');assert.equal(h.metrics.writes,1);
});
