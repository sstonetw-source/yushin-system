const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function functionSource(name){const start=src.indexOf(`function ${name}(`);assert.ok(start>=0);return src.slice(start,src.indexOf('\n}',start)+2);}
test('quote drafts are isolated by authenticated UID',()=>{
 const c=vm.createContext({currentUser:{uid:'sales-A'}});
 vm.runInContext("const QUOTE_DRAFT_STORAGE_KEY='quote_draft_v2';"+src.match(/function quoteDraftStorageKey\(\) \{[^\n]+\}/)[0],c);
 assert.equal(c.quoteDraftStorageKey(),'quote_draft_v2:sales-A');
 c.currentUser={uid:'engineer-B'};assert.equal(c.quoteDraftStorageKey(),'quote_draft_v2:engineer-B');
 assert.match(functionSource('saveQuoteDraft'),/if \(!currentUser\) return/);
 assert.match(functionSource('loadQuoteDraft'),/if \(!currentUser\) return null/);
 assert.match(src,/uid === currentUser\?\.uid && generation === sessionDataGeneration/);
});
test('order item limit rejects before order writes and accepts exactly thirty',()=>{
 const c=vm.createContext({});vm.runInContext('const MAX_ORDER_ITEMS=30;'+functionSource('assertOrderItemCount'),c);
 assert.doesNotThrow(()=>c.assertOrderItemCount(Array(30).fill({})));
 assert.throws(()=>c.assertOrderItemCount(Array(31).fill({})),/30/);
 for(const name of ['window.saveNewOrder =','window.markQuoteAsDeal =','async function createForecastOrdersDirectly']){
  const start=src.indexOf(name);assert.ok(start>=0,name);
  assert.match(src.slice(start,src.indexOf('assertOrderItemCount(',start)+100),/assertOrderItemCount/);
 }
});
test('reset refuses protected evidence before any delete is executed',async()=>{
 const reads=[],c=vm.createContext({TEST_DATA_RESET_PROTECTED_COLLECTIONS:['stockTransfers','stockTransferRequests','stockOperations'],
  firestoreReadWithTimeout:p=>p,db:{collection:name=>({limit:n=>({get:async()=>{reads.push([name,n]);return {empty:name!=='stockOperations'};}})})}});
 vm.runInContext('async '+functionSource('assertClientTestResetSafe'),c);
 await assert.rejects(c.assertClientTestResetSafe(),/前台初始化/);
 assert.equal(reads.length,3);
 const execute=src.slice(src.indexOf('window.executeTestDataReset ='),src.indexOf('let systemDataAuditIssues'));
 assert.ok(execute.indexOf('await assertClientTestResetSafe()')<execute.indexOf('await deleteCollectionInBatches'));
});
test('pending and delivery lot reads exclude completed work and depleted lots at query level',()=>{
 assert.match(functionSource('pendingOrderWorkQuery'),/workCategories.*array-contains-any/);
 assert.match(src,/where\('remainingQty',\s*'>',\s*0\)/);
 const indexes=require('../firestore.indexes.json').indexes;
 assert.ok(indexes.some(i=>i.collectionGroup==='orders'&&i.fields.some(f=>f.fieldPath==='ownerUid')&&i.fields.some(f=>f.fieldPath==='workCategories'&&f.arrayConfig==='CONTAINS')));
 assert.ok(indexes.some(i=>i.collectionGroup==='inventoryLots'&&i.fields.some(f=>f.fieldPath==='remainingQty')&&i.fields.some(f=>f.fieldPath==='productKey')));
});
test('an old permission probe cannot repopulate another account session',async()=>{
 let resolve;const pending=new Promise(r=>resolve=r);
 const c=vm.createContext({currentUser:{uid:'A'},sessionDataGeneration:1,permissionRulesReady:false,permissionRulesCheckedUid:'',permissionRulesCheckPromise:null,
  firestoreReadWithTimeout:p=>p,db:{collection:()=>({doc:()=>({get:()=>pending})})},applyPermissionVisibility(){throw Error('stale render');},console});
 vm.runInContext(functionSource('ensurePermissionRulesReady'),c);
 const old=c.ensurePermissionRulesReady();c.currentUser={uid:'B'};c.sessionDataGeneration=2;c.permissionRulesCheckPromise='new account probe';
 resolve({});assert.equal(await old,false);assert.equal(c.permissionRulesReady,false);assert.equal(c.permissionRulesCheckedUid,'');assert.equal(c.permissionRulesCheckPromise,'new account probe');
});
