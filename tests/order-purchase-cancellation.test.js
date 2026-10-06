const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const app=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const inventory=require('../modules/inventory-core');
const supplyCore=require('../modules/supply-core');
function fn(name){const start=app.indexOf(`function ${name}(`);assert.ok(start>=0,name);return (app.slice(start-6,start)==='async '?'async ':'')+app.slice(start,app.indexOf('\n}',start)+2);}
function metricsFixture(){
 const context=vm.createContext({
  supplyReceivingCache:[
   {id:'cancelled-source',orderId:'O1',status:'ORDERED',qty:1,receivedQty:0,unitCost:10293,brand:'B'},
   {id:'partial',orderId:'O2',status:'PARTIAL_RECEIPT',qty:10,receivedQty:4,unitCost:80,fulfillmentType:'DIRECT_SHIP',brand:'B'},
   {id:'stock',status:'ORDERED',qty:2,receivedQty:0,unitCost:20,brand:'B'},
   {id:'missing',status:'ORDERED',qty:3,receivedQty:0,brand:'B'},
   {id:'stopped',status:'CANCELLED',qty:5,receivedQty:0,unitCost:999,brand:'B'},
   {id:'closed',status:'CLOSED',qty:5,receivedQty:1,unitCost:999,brand:'B'}
  ],
  purchaseFilterContext:()=>({selectedSales:'',selectedBrand:''}),
  receivingSourceOrderForItem:s=>s.orderId?{status:s.orderId==='O1'?'cancelled':'normal',salesName:s.orderId==='O1'?'Sales A':'Sales B'}:null,
  purchaseLineMatchesFilters:(_date,sales,brand,f)=>(!f.selectedSales||sales===f.selectedSales)&&(!f.selectedBrand||brand===f.selectedBrand),
  YushinSupply:supplyCore
 });
 vm.runInContext(fn('tradeAnalysisCost')+'\n'+fn('receivingSupplyMetrics'),context);return context;
}
test('receiving totals include cancelled customer commitments and use only remaining purchase cost',()=>{
 const c=metricsFixture();c.supplyReceivingCache.push(c.supplyReceivingCache[0]);
 assert.deepEqual(JSON.parse(JSON.stringify(c.receivingSupplyMetrics())),{count:4,quantity:12,amount:10813,missingCost:1});
 assert.deepEqual(JSON.parse(JSON.stringify(c.receivingSupplyMetrics({selectedSales:'Sales A'}))),{count:3,quantity:6,amount:10333,missingCost:1});
 assert.equal(c.receivingSupplyMetrics({selectedBrand:'Different'}).count,0);
});
test('both purchasing methods show cancellation only to admin or purchaser, never terminal or self-order',()=>{
 for(const role of ['admin','purchaser','warehouse','sales','engineer']){
  const c=vm.createContext({canCreatePurchaseOrderCapability:()=>['admin','purchaser'].includes(role),isPurchaseTerminalStatus:s=>['CANCELLED','CLOSED','RECEIVED'].includes(s),purchaseCancellationInProgress:new Set(),inlineJsValue:JSON.stringify});
  vm.runInContext(fn('supplyCancelActionHtml'),c);
  for(const type of ['PURCHASING_MANUAL','PURCHASING_PO'])assert.equal(!!c.supplyCancelActionHtml({id:'S1',type,status:'ORDERED',qty:3,receivedQty:1}),['admin','purchaser'].includes(role));
  assert.equal(c.supplyCancelActionHtml({id:'S1',type:'SALES_SELF_ORDER',status:'ORDERED',qty:3}), '');
  assert.equal(c.supplyCancelActionHtml({id:'S1',type:'PURCHASING_PO',status:'CLOSED',qty:3}), '');
  assert.equal(c.supplyCancelActionHtml({id:'S1',type:'PURCHASING_PO',status:'ORDERED',qty:3,receivedQty:3}), '');
 }
});
test('formal receiving line cancellation targets just its supply, retaining another PO line',async()=>{
 const supply={id:'S1',type:'PURCHASING_PO',status:'ORDERED',qty:3,receivedQty:1,purchaseDocumentId:'PO1',purchaseDocumentNo:'PO-01',itemCode:'ABC'};
 const calls=[],alerts=[],prompts=[];
 const c=vm.createContext({window:{},canCreatePurchaseOrderCapability:()=>true,purchaseCancellationInProgress:new Set(),purchaseHistorySupplyCache:new Map(),supplyReceivingCache:[supply,{id:'S2',purchaseDocumentId:'PO1'}],
  supplyOrdersCollection:()=>({doc:()=>({get:async()=>({exists:true,data:()=>supply})})}),firestoreReadWithTimeout:p=>p,
  isPurchaseTerminalStatus:s=>['CANCELLED','CLOSED'].includes(s),prompt:message=>{prompts.push(message);return 'Supplier stopped shipment';},alert:message=>alerts.push(message),document:{getElementById:()=>null},
  cancelOutstandingSupplyRecord:async(...args)=>{calls.push(args);return {terminalStatus:'CLOSED',cancelledQty:2,receivedQty:1,orderId:''};},loadActiveReceivingSupplyCache:async()=>{},refreshAffectedOrderCaches:async()=>{},showActionFeedback:()=>{},console});
 const start=app.indexOf('window.cancelSupplyOutstanding = async function');
 vm.runInContext(app.slice(start,app.indexOf('\nwindow.cancelPurchaseOrderOutstanding',start)),c);
 await c.window.cancelSupplyOutstanding('S1');
 assert.deepEqual(calls,[['PO1','S1','Supplier stopped shipment']]);
 assert.deepEqual([...c.supplyReceivingCache].map(row=>row.id),['S2']);
 assert.equal(c.purchaseHistorySupplyCache.get('S1').status,'CLOSED');
 assert.match(prompts[0],/只取消此品項/);assert.equal(alerts.length,0);
});
test('cancelled order retains a customer-return entry while commercial role restrictions remain',()=>{
 for(const role of ['admin','sales','engineer','purchaser','warehouse']){
  const business=['admin','sales','engineer'].includes(role);
  const c=vm.createContext({canManageOrderLifecycleCapability:()=>business,canEditPage:()=>business,pendingLifecycleOrderIds:new Set(),inlineJsValue:JSON.stringify});
  vm.runInContext(fn('orderLifecycleActionButtons'),c);
  const html=c.orderLifecycleActionButtons({id:'O1'},{status:'cancelled'},{remaining:2,delivered:1},{showReturn:true});
  assert.equal(html.includes('openReturnManagement'),business);
  assert.equal(html.includes('恢復訂單'),business);
  assert.equal(html.includes('取消訂單'),false);
 }
});
test('cancelled delivered order displays the new return form but never exposes it to purchaser',()=>{
 for(const business of [true,false]){
  const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,{style:{},value:'',innerHTML:''});return elements.get(id);};
  const c=vm.createContext({ordersCache:[{id:'O1',returnRecords:[]}],currentLifecycleOrderId:'O1',canManageOrderLifecycleCapability:()=>business,canEditPage:()=>business,
   orderLifecycleInfo:()=>({status:'cancelled',effectiveDelivered:1,delivered:2,returned:1}),document:{getElementById:get},escapeHtml:String,savedReturnRecords:o=>o.returnRecords,populateReturnItemOptions:()=>{},updateReturnFormHint:()=>{},onOrderLifecycleStatusChange:()=>{}});
  vm.runInContext(fn('renderOrderLifecycleModal'),c);c.renderOrderLifecycleModal();
  assert.equal(get('returnFormPanel').style.display,business?'':'none');
 }
});
function returnFixture(cancelled=false){
 const docs=new Map([
  ['inventory/P1',{onHand:1,reserved:cancelled?0:1,incoming:0}],['warehouseStocks/W1-P1',{onHand:1,reserved:cancelled?0:1,incoming:0}],
  ['inventoryReservations/O1__I1',{quantity:cancelled?0:1}],['inventoryLots/A',{remainingQty:0}],['inventoryLots/B',{remainingQty:1}]
 ]);
 let id=0;const db={collection:name=>({doc:key=>({path:name+'/'+(key||'movement-'+(++id))})})};
 const tx={get:async ref=>({exists:docs.has(ref.path),data:()=>({...docs.get(ref.path)})}),update:(ref,data)=>docs.set(ref.path,{...docs.get(ref.path),...data}),set:(ref,data)=>docs.set(ref.path,{...docs.get(ref.path),...data})};
 const prior={id:'R1',qty:1,lotAllocations:[{lotId:'B',qty:1,unitCost:200,cost:200}]};
 const order={itemId:'I1',qty:2,warehouseId:'W1',productId:'P1',status:cancelled?'cancelled':'normal',ownerUid:'sales1',
  deliveryRecords:[{qty:2,lotAllocations:[{lotId:'A',qty:1,unitCost:100},{lotId:'B',qty:1,unitCost:200}]}],returnRecords:[]};
 const c=vm.createContext({db,YushinInventory:inventory,inventoryProductKey:o=>o.productId,defaultWarehouse:()=>({id:'W1'}),inventoryRefFor:()=>db.collection('inventory').doc('P1'),warehouseStockDocId:(w,p)=>w+'-'+p,
  inventoryNumbers:inventory.normalizeStock,savedDeliveryRecords:o=>o.deliveryRecords,savedReturnRecords:o=>o.returnRecords,normalizedOrderStatus:o=>o.status,inventoryReservationPayload:()=>({}),DOCUMENT_TYPES:{ORDER:'order'}});
 vm.runInContext(fn('applyInventoryReturnDeltaInTransaction'),c);return {c,tx,docs,prior,order};
}
test('editing a one-unit return to two restores the other batch, never the already returned batch',async()=>{
 for(const cancelled of [false,true]){
  const {c,tx,docs,prior,order}=returnFixture(cancelled);
  const result=await c.applyInventoryReturnDeltaInTransaction(tx,order,1,'Sales A','O1',prior);
  assert.equal(result.lotAllocations[0].lotId,'A');assert.equal(result.cogs,100);
  assert.equal(docs.get('inventoryLots/A').remainingQty,1);assert.equal(docs.get('inventoryLots/B').remainingQty,1);
  assert.equal(docs.get('inventory/P1').onHand,2);assert.equal(docs.get('inventory/P1').reserved,cancelled?0:2);
  assert.equal(result.newReservedQty,cancelled?0:2);
 }
});
test('shrinking an edited return removes only its latest returned lot',async()=>{
 const {c,tx,docs,prior,order}=returnFixture();docs.get('inventoryLots/A').remainingQty=1;
 const edited={...prior,qty:2,lotAllocations:[...prior.lotAllocations,{lotId:'A',qty:1,unitCost:100,cost:100}]};
 const result=await c.applyInventoryReturnDeltaInTransaction(tx,order,-1,'Sales A','O1',edited);
 assert.equal(result.lotAllocations[0].lotId,'A');assert.equal(docs.get('inventoryLots/A').remainingQty,0);assert.equal(docs.get('inventoryLots/B').remainingQty,1);
});

test('successful stock or order transactions invalidate analysis, failed transactions preserve the previous report',async()=>{
 for(const ready of [true,false]){
  const dirty=[];
  const c=vm.createContext({permissionRulesReady:ready,ensurePermissionRulesReady:async()=>{},currentUser:{uid:'sales1'},currentUserRole:'sales',
   db:{runTransaction:async callback=>callback({})},YushinStockPermissions:{run:async(_db,callback)=>callback({})},
   tradeAnalysisReady:true,tradeAnalysisLoadedKey:'old-report',markMainPageDirty:key=>dirty.push(key)});
  vm.runInContext(fn('runRoleTransaction'),c);
  assert.equal(await c.runRoleTransaction(async()=> 'committed'),'committed');
  assert.equal(c.tradeAnalysisReady,false);assert.equal(c.tradeAnalysisLoadedKey,'');assert.deepEqual(dirty,['admin']);
  c.tradeAnalysisReady=true;c.tradeAnalysisLoadedKey='existing-report';
  await assert.rejects(c.runRoleTransaction(async()=>{throw new Error('Denied');}),/Denied/);
  assert.equal(c.tradeAnalysisReady,true);assert.equal(c.tradeAnalysisLoadedKey,'existing-report');assert.deepEqual(dirty,['admin']);
 }
});

test('settlement return adds free stock while preserving reservations for remaining normal order quantities',async()=>{
 const {c,tx,docs,order}=returnFixture();order.customerReturnSettlement='CLOSE';
 const result=await c.applyInventoryReturnDeltaInTransaction(tx,order,1,'Receiver','O1',null);
 assert.equal(docs.get('inventory/P1').onHand,2);
 assert.equal(docs.get('inventory/P1').reserved,1);
 assert.equal(result.newReservedQty,1);
});
