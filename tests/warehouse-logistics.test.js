const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const core=require('../modules/warehouse-logistics'),inventory=require('../modules/inventory-core'),fulfillment=require('../modules/fulfillment-core'),workspace=require('../modules/inventory-workspace');
const src=fs.readFileSync('modules/warehouse-logistics.js','utf8');
test('recipient validation groups warehouse and destination without courier-only fields',()=>{
 assert.throws(()=>core.validatePlan({mode:'SALES_SHIP'},true),/收件人/);
 assert.throws(()=>core.validatePlan({mode:'TRANSFER',warehouseId:''}),/倉庫/);
 const stripped=core.validatePlan({mode:'PICKUP',packages:0,condition:'冷藏',tracking:'old'});
 assert.equal(stripped.packages,1);assert.equal('condition' in stripped,false);assert.equal('tracking' in stripped,false);
 const p={mode:'CUSTOMER_SHIP',contact:'A',phone:'123',address:'台北',condition:'冷藏'};
 const rows=[{warehouseId:'MAIN',p},{warehouseId:'MAIN',p},{warehouseId:'MAIN',p:{...p,address:'台南'}},{warehouseId:'MAIN',p:{...p,condition:'常溫'}},{warehouseId:'EXT',p}];
 const groups=core.partition(rows,r=>r.p);assert.equal(groups.length,3);assert.equal(groups[0].rows.length,3);
});
test('batch retries only unfinished items, including an uncertain successful commit',async()=>{
 const p={mode:'CUSTOMER_SHIP',contact:'Luke',phone:'123',address:'台北'};
 const rows=[1,2,3].map(n=>({key:'O__'+n,warehouseId:'MAIN',warehouse:{id:'MAIN'},qty:n,order:{},item:{},p}));
 const jobs=core.batchJobs(rows,r=>r.p,'B'),posted=new Set(),calls=[];let interrupted=true;
 const commit=async j=>{calls.push(j.operationId);posted.add(j.operationId);if(j.operationId==='B-1'&&interrupted){interrupted=false;throw Error('response lost');}};
 assert.deepEqual(await core.processBatch(jobs,commit),{completed:1,total:3,complete:false});
 assert.equal(jobs[1].error,'response lost');assert.equal(jobs[2].done,false);
 assert.deepEqual(await core.processBatch(jobs,commit),{completed:3,total:3,complete:true});
 assert.deepEqual(calls,['B-0','B-1','B-1','B-2']);assert.equal(posted.size,3);
 await core.processBatch(jobs,commit);assert.equal(calls.length,4);
});
test('batch preflight rejects duplicate rows, unknown warehouses and incomplete recipients',()=>{
 const r={key:'O__A',warehouseId:'MAIN',warehouse:{id:'MAIN'},qty:1,order:{},item:{}};
 assert.throws(()=>core.batchJobs([],()=>({}),'B'));
 assert.throws(()=>core.batchJobs([r,r],()=>({mode:'PICKUP'}),'B'));
 assert.throws(()=>core.batchJobs([{...r,warehouse:null}],()=>({mode:'PICKUP'}),'B'));
 assert.throws(()=>core.batchJobs([r],()=>({mode:'CUSTOMER_SHIP',address:'台北'}),'B'),/收件人/);
 assert.throws(()=>core.batchJobs([{...r,qty:NaN}],()=>({mode:'PICKUP'}),'B'));
 assert.equal(core.batchJobs([r],()=>({mode:'PICKUP'}),'B')[0].qty,1);
});
test('export groups recipients and preserves codes, quantities, notes and quoted addresses without posting stock',()=>{
 const p={mode:'CUSTOMER_SHIP',contact:'客戶',phone:'0912345678',address:'台北,"二樓"',condition:'冷凍',notes:'請電聯\n到貨'};
 const r={warehouseId:'EXT',qty:2,order:{orderNo:'YS-1',salesName:'Luke',customerName:'醫院'},item:{itemCode:'00123',itemName:'=SUM(A1)'}};
 const groups=core.partition([r,{...r,qty:1,item:{itemCode:'00456',itemName:'試劑'}}],()=>p);
 const csv=core.csvDocument(groups);assert.equal(groups.length,1);assert.equal(groups[0].rows.length,2);
 assert.ok(csv.startsWith('\uFEFF'));assert.match(csv,/"00123"/);assert.match(csv,/"台北,""二樓"""/);assert.match(csv,/"'\=SUM\(A1\)"/);assert.doesNotMatch(csv,/冷凍|溫層|物流單號|件數/);assert.match(csv,/"請電聯\n到貨"/);
});
function fixture({retry=false}={}){
 const docs=new Map([
  ['inventory/P',{productKey:'P',productId:'P',itemCode:'001',itemName:'Product',brand:'QIAGEN',onHand:10,reserved:4,incoming:0}],
  ['warehouseStocks/MAIN__P',{productKey:'P',warehouseId:'MAIN',onHand:10,reserved:4,incoming:0}],
  ['warehouses/MAIN',{warehouseName:'又鑫',active:true}],['warehouses/EXT',{warehouseName:'勝力',active:true}],
  ['inventoryLots/L',{productKey:'P',warehouseId:'MAIN',remainingQty:10,qty:10,lotNo:'LOT1',expiryDate:'2027-01-01'}],
  ['inventoryLotCosts/L',{unitCost:90}],
  ['orders/O',{ownerUid:'S',salesCode:'01',salesName:'Luke',customerName:'Customer',status:'active',deliveryRecords:[],returnRecords:[],items:[{itemId:'A',productId:'P',itemCode:'001',itemName:'Product',qty:4,reservedQty:4,warehouseId:'MAIN',dispatchPreparedQty:4,deliveryPlan:{mode:'TRANSFER',warehouseId:'EXT',contact:'Wh',phone:'123',address:'台北'}}]}],
  ['inventoryReservations/O__A',{orderId:'O',itemId:'A',warehouseId:'MAIN',productKey:'P',quantity:4,status:'active'}]
 ]);
 const ref=(col,id)=>({id,path:col+'/'+id});let failCommit=false,commits=0;
 const c=vm.createContext({YushinReservation:require('../modules/reservation-core'),currentUser:{uid:'buyer'},currentUserRole:'purchaser',currentUserName:'Buyer',currentUserCode:'P01',warehouseMasterCache:[{id:'MAIN',active:true},{id:'EXT',active:true}],
   canReceiveInventoryCapability:()=>true,canAccessPage:()=>true,deliveryActor:()=> 'Buyer',defaultWarehouse:()=>({id:'MAIN'}),allocateFreeReceiptStockToShortages:async()=>({affectedOrderIds:[]}),
   inventoryRefFor:i=>ref('inventory',i.productId),warehouseStockDocId:(w,p)=>w+'__'+p,
   normalizedOrderStatus:o=>o.status==='cancelled'?'cancelled':'normal',orderInventorySyncIncomplete:()=>false,
   normalizedOrderItems:o=>o.items,inventoryProductKey:i=>i.productId,
   itemDispatchState:(_o,i)=>fulfillment.dispatchState(i),orderWorkIndexFields:()=>({workCategories:['delivery']}),
   firestoreReadWithTimeout:async p=>p,YushinInventory:inventory,YushinWarehouseLogistics:core,YushinFulfillment:fulfillment,
   firebase:{firestore:{FieldValue:{arrayUnion:v=>({union:v})}}},
   db:{collection:col=>({doc:id=>ref(col,id),where(field,_op,value){const predicates=[[field,value]];const query={where(f,_o,v){predicates.push([f,v]);return query;},limit(){return query;},get:async()=>{const result=[...docs.entries()].filter(([path,data])=>path.startsWith(col+'/')&&predicates.every(([f,v])=>data[f]===v)).map(([path,data])=>({id:path.split('/')[1],ref:ref(col,path.split('/')[1]),exists:true,data:()=>structuredClone(data)}));return {docs:result,size:result.length};}};return query;}})},
   runRoleTransaction:async fn=>{
    const writes=[];const tx={get:async r=>({id:r.id,ref:r,exists:docs.has(r.path),data:()=>structuredClone(docs.get(r.path))}),update:(r,d)=>writes.push([r,d,true]),set:(r,d,options)=>writes.push([r,d,!!options?.merge])};
    await fn(tx);if(retry){writes.length=0;await fn(tx);}if(failCommit)throw Error('網路中斷');
    for(const [r,data,merge] of writes){const base=merge?docs.get(r.path)||{}:{};const d={...data};for(const [key,value] of Object.entries(d))if(value?.union)d[key]=[...(base[key]||[]),value.union];docs.set(r.path,{...base,...d});}commits+=1;
   }
 });
 vm.runInContext(src+'\n'+fs.readFileSync('src/services/warehouse-transfer.js','utf8'),c);return {c,docs,ref,fail:()=>{failCommit=true;},commits:()=>commits};
}
test('free transfer receipt persists pending allocation and retries without receiving stock or lots twice',async()=>{
 const f=fixture();const args={id:'FREE-RETRY',inventoryId:'P',fromWarehouseId:'MAIN',toWarehouseId:'EXT',qty:3};
 await f.c.commitWarehouseTransfer(args);
 let fail=true;const calls=[];
 f.c.allocateFreeReceiptStockToShortages=async(...values)=>{calls.push(values);if(fail)throw Error('offline');return {affectedOrderIds:['WAITING']};};
 await assert.rejects(f.c.commitWarehouseTransferReceipt(args.id),/調撥已入庫/);
 assert.equal(f.docs.get('stockTransfers/FREE-RETRY').allocationCompleted,false);
 assert.equal(f.docs.get('warehouseStocks/EXT__P').onHand,3);
 const lotCount=[...f.docs.keys()].filter(k=>k.startsWith('inventoryLots/')).length;
 fail=false;const result=await f.c.commitWarehouseTransferReceipt(args.id);
 assert.equal(f.docs.get('stockTransfers/FREE-RETRY').allocationCompleted,true);
 assert.equal(f.docs.get('warehouseStocks/EXT__P').onHand,3);
 assert.equal([...f.docs.keys()].filter(k=>k.startsWith('inventoryLots/')).length,lotCount);
 assert.equal(result.affectedOrderIds[0],'WAITING');assert.equal(calls[1][6],'stockTransfers');
 await f.c.commitWarehouseTransferReceipt(args.id);assert.equal(calls.length,2);
});
test('transaction retry fixes transfer actor once and preserves stock and customer delivery boundaries',async()=>{
 const f=fixture({retry:true});let actorCalls=0;f.c.deliveryActor=()=> 'Actor-'+(++actorCalls);
 await f.c.commitWarehouseTransfer({id:'RETRY',orderId:'O',itemId:'A',qty:4,toWarehouseId:'EXT'});
 assert.equal(actorCalls,1);assert.equal(f.docs.get('warehouseStocks/MAIN__P').onHand,6);
 assert.equal(f.docs.get('inventory/P').onHand,10);assert.equal(f.docs.get('orders/O').deliveryRecords.length,0);
 await f.c.commitWarehouseTransferReceipt('RETRY');
 assert.equal(actorCalls,2);assert.equal(f.docs.get('warehouseStocks/EXT__P').onHand,4);
 assert.equal(f.docs.get('inventory/P').transferInTransit,0);
 assert.equal(f.docs.get('orders/O').deliveryRecords.length,0);
});
test('transactional lot reread rejects changed product or warehouse before any dispatch write',async()=>{
 for(const patch of [{productKey:'OTHER'},{warehouseId:'OTHER'}]){
   const f=fixture();f.c.firestoreReadWithTimeout=async promise=>{const result=await promise;Object.assign(f.docs.get('inventoryLots/L'),patch);return result;};
   await assert.rejects(f.c.commitWarehouseTransfer({id:'STALE',orderId:'O',itemId:'A',qty:4,toWarehouseId:'EXT'}),/批次的產品或來源倉庫已變更/);
   assert.equal(f.docs.has('stockTransfers/STALE'),false);
   assert.equal(f.docs.get('warehouseStocks/MAIN__P').onHand,10);
   assert.equal(f.docs.get('inventory/P').transferInTransit,undefined);
   assert.equal(f.docs.get('inventoryReservations/O__A').warehouseId,'MAIN');
 }
});
test('a session switch after receipt keeps committed goods but pauses automatic allocation until safe retry',async()=>{
 const f=fixture();await f.c.commitWarehouseTransfer({id:'SESSION',inventoryId:'P',fromWarehouseId:'MAIN',toWarehouseId:'EXT',qty:3});
 const run=f.c.runRoleTransaction;let allocations=0;
 f.c.runRoleTransaction=async callback=>{await run(callback);f.c.currentUser={uid:'other'};};
 f.c.allocateFreeReceiptStockToShortages=async()=>{allocations++;return {affectedOrderIds:[]};};
 await assert.rejects(f.c.commitWarehouseTransferReceipt('SESSION'),error=>error.transferCommitted===true&&/登入身分已變更/.test(error.message));
 assert.equal(allocations,0);assert.equal(f.docs.get('warehouseStocks/EXT__P').onHand,3);
 assert.equal(f.docs.get('stockTransfers/SESSION').allocationCompleted,false);
 f.c.currentUser={uid:'buyer'};f.c.runRoleTransaction=run;
 await f.c.commitWarehouseTransferReceipt('SESSION');
 assert.equal(allocations,1);assert.equal(f.docs.get('warehouseStocks/EXT__P').onHand,3);
 assert.equal(f.docs.get('stockTransfers/SESSION').allocationCompleted,true);
});
test('role switch during post-receipt allocation cannot mark the checkpoint completed in the new role',async()=>{
 const f=fixture();await f.c.commitWarehouseTransfer({id:'ROLE',inventoryId:'P',fromWarehouseId:'MAIN',toWarehouseId:'EXT',qty:3});
 f.c.allocateFreeReceiptStockToShortages=async()=>{f.c.currentUserRole='warehouse';return {affectedOrderIds:[]};};
 await assert.rejects(f.c.commitWarehouseTransferReceipt('ROLE'),error=>error.transferCommitted===true);
 assert.equal(f.docs.get('stockTransfers/ROLE').allocationCompleted,false);
 assert.equal(f.docs.get('warehouseStocks/EXT__P').onHand,3);
});
test('transfer retry cannot turn a previous order transfer into a different destination or salesperson handoff',async()=>{
 const f=fixture(),args={id:'ORDER-ID',orderId:'O',itemId:'A',qty:4,toWarehouseId:'EXT'};
 await f.c.commitWarehouseTransfer(args);
 await f.c.commitWarehouseTransfer(args);
 const before=JSON.stringify([...f.docs]);
 for(const patch of [
  {toWarehouseId:'MAIN'},
  {handoff:true,toWarehouseId:''},
  {expectedWarehouseId:'OTHER'},
  {expectedPlan:{mode:'PICKUP'}}
 ]){
  await assert.rejects(f.c.commitWarehouseTransfer({...args,...patch}),/識別碼衝突/);
  assert.equal(JSON.stringify([...f.docs]),before);
 }
});
test('one replenishment transfer ID cannot confirm a second pending request',async()=>{
 const f=mainRequestFixture(),base={inventoryId:'P',fromWarehouseId:'EXT',qty:3};
 await f.c.createMainTransferRequest({id:'REQ1',...base});
 const first={id:'SEND-ONCE',requestId:'REQ1',...base,toWarehouseId:'MAIN'};
 await f.c.commitWarehouseTransfer(first);
 await f.c.createMainTransferRequest({id:'REQ2',...base});
 const before=JSON.stringify([...f.docs]);
 for(const patch of [{requestId:'REQ2'},{requestId:''}]){
  await assert.rejects(f.c.commitWarehouseTransfer({...first,...patch}),/識別碼衝突/);
  assert.equal(JSON.stringify([...f.docs]),before);
  assert.equal(f.docs.get('stockTransferRequests/REQ2').status,'PENDING');
 }
 await f.c.commitWarehouseTransfer(first);
 assert.equal(JSON.stringify([...f.docs]),before);
});
test('free transfer is atomic, retains company total and lot identity, and hides transit stock from availability until received',async()=>{
 const f=fixture();await f.c.commitWarehouseTransfer({id:'T',inventoryId:'P',fromWarehouseId:'MAIN',toWarehouseId:'EXT',qty:3});
 assert.equal(f.docs.get('inventory/P').onHand,10);assert.equal(inventory.normalizeStock(f.docs.get('inventory/P')).available,3);
 assert.equal(f.docs.get('warehouseStocks/MAIN__P').onHand,7);assert.equal(f.docs.has('warehouseStocks/EXT__P'),false);assert.equal(f.docs.get('inventoryLots/L').remainingQty,7);
 await f.c.commitWarehouseTransfer({id:'T',inventoryId:'P',fromWarehouseId:'MAIN',toWarehouseId:'EXT',qty:3});assert.equal(f.docs.get('warehouseStocks/MAIN__P').onHand,7);
 await f.c.commitWarehouseTransferReceipt('T');await f.c.commitWarehouseTransferReceipt('T');
 assert.equal(f.docs.get('warehouseStocks/EXT__P').onHand,3);assert.equal(f.docs.get('inventory/P').transferInTransit,0);assert.equal(inventory.normalizeStock(f.docs.get('inventory/P')).available,6);
 assert.equal(f.docs.get('inventoryLots/T-0').lotNo,'LOT1');assert.equal(f.docs.get('inventoryLots/T-0').expiryDate,'2027-01-01');assert.equal(f.docs.get('inventoryLotCosts/T-0').costSourceLotId,'L');
});
test('order transfer preserves commercial values and reservation, then changes warehouse only on receipt',async()=>{
 const f=fixture();const before=structuredClone(f.docs.get('orders/O'));
 await f.c.commitWarehouseTransfer({id:'T',orderId:'O',itemId:'A',qty:4,toWarehouseId:'EXT'});
 const order=f.docs.get('orders/O');assert.equal(order.items[0].warehouseId,'MAIN');assert.equal(order.items[0].transferPendingId,'T');assert.equal(order.items[0].reservedQty,4);assert.equal(order.deliveryRecords.length,0);assert.equal(order.logisticsTransfersPending,1);
 assert.equal(f.docs.get('inventory/P').onHand,10);assert.equal(f.docs.get('inventory/P').reserved,4);
 await f.c.commitWarehouseTransferReceipt('T');const after=f.docs.get('orders/O');assert.equal(after.items[0].warehouseId,'EXT');assert.equal(after.items[0].transferPendingId,'');assert.equal(after.items[0].qty,before.items[0].qty);assert.equal(after.ownerUid,before.ownerUid);assert.equal(after.deliveryRecords.length,0);assert.equal(after.logisticsTransfersPending,0);
 assert.equal(f.docs.get('inventoryReservations/O__A').warehouseId,'EXT');assert.equal(f.docs.get('warehouseStocks/EXT__P').reserved,4);
});
test('controlled v2 transfer resolves the actual moving warehouse even when the order display warehouse equals the destination',async()=>{
 const f=fixture(),c=f.c,calls=[];
 const order=f.docs.get('orders/O');order.items[0].reservedQty=4;
 f.docs.set('inventoryReservations/O__A',{orderId:'O',itemId:'A',productKey:'P',quantity:4,shortageQty:0,status:'active',
  locationSchemaVersion:2,lifecycleWarehouseIds:['MAIN','EXT'],locations:[{warehouseId:'MAIN',reservedQty:1},{warehouseId:'EXT',reservedQty:3}]});
 let readCount=0,pending=[];
 c.orderTransferBackendRequired=()=>true;c.pendingOrderTransferOperations=()=>pending;
 c.commitOrderTransferBackend=async(action,transferId,payload)=>{calls.push({action,transferId,payload});return {status:'applied'};};
 c.db={collection:name=>({doc:key=>({get:async()=>{readCount++;const data=f.docs.get(name+'/'+key);return {exists:!!data,data:()=>structuredClone(data)};}})})};
 const input={id:'V2-MOVE',orderId:'O',itemId:'A',expectedWarehouseId:'MAIN',fromWarehouseId:'MAIN',toWarehouseId:'MAIN',qty:4,
  expectedPlan:core.plan({mode:'PICKUP'})};
 await c.commitWarehouseTransfer(input);
 assert.equal(calls[0].action,'DISPATCH');assert.equal(calls[0].payload.fromWarehouseId,'EXT');
 assert.equal(calls[0].payload.qty,4);assert.equal(readCount,2);
 pending=[{id:input.id,action:'DISPATCH'}];await c.commitWarehouseTransfer(input);
 assert.equal(calls[1].payload,undefined);assert.equal(readCount,2);
});
test('handoff keeps goods reserved in salesperson custody and does not mark customer delivery or expose them in warehouse shipping queue',async()=>{
 const f=fixture();f.docs.get('orders/O').items[0].deliveryPlan={mode:'PICKUP'};
 await f.c.commitWarehouseTransfer({id:'H',orderId:'O',itemId:'A',qty:4,handoff:true});
 const order=f.docs.get('orders/O');assert.equal(order.items[0].warehouseId,'custody-S');assert.equal(order.deliveryRecords.length,0);assert.equal(order.deliveredQty,undefined);
 assert.equal(f.docs.get('warehouseStocks/custody-S__P').onHand,4);assert.equal(f.docs.get('warehouseStocks/custody-S__P').reserved,4);assert.equal(f.docs.get('inventoryReservations/O__A').warehouseId,'custody-S');assert.equal(f.docs.get('inventory/P').onHand,10);assert.equal(f.docs.get('inventory/P').reserved,4);
 const wh=[{id:'MAIN'}, {id:'custody-S',systemCustody:true}];
 const helpers={status:()=> 'normal',incomplete:()=>false,items:o=>o.items,dispatch:(_o,i)=>fulfillment.dispatchState(i)};
 assert.equal(workspace.shippingRows([{...order,id:'O'}],wh,'MAIN',helpers).length,0);
 assert.equal(workspace.shippingRows([{...order,id:'O'}],wh,'MAIN',{...helpers,includeCustody:true}).length,1);
});
test('partial failure, invalid stock, missing batches, cancelled order and role denial never leave half a transfer',async()=>{
 for(const kind of ['network','quantity','lots','cancelled','role']){
  const f=fixture(),before=structuredClone([...f.docs]);let args={id:'T',orderId:'O',itemId:'A',qty:4,toWarehouseId:'EXT'};
  if(kind==='network')f.fail();if(kind==='quantity')args.qty=40;if(kind==='lots')f.docs.delete('inventoryLots/L');if(kind==='cancelled')f.docs.get('orders/O').status='cancelled';if(kind==='role')f.c.canReceiveInventoryCapability=()=>false;
  const state=structuredClone([...f.docs]);await assert.rejects(f.c.commitWarehouseTransfer(args));assert.deepEqual([...f.docs],state);assert.equal(f.docs.has('stockTransfers/T'),false);
 }
});
test('transit inventory cannot be archived and transferred lot allocations retain protected cost identity',()=>{
 assert.equal(inventory.stockIsEmpty({transferInTransit:1}),false);
 assert.equal(inventory.allocateLots([{id:'Moved',remainingQty:2,costLotId:'Root'}],1).allocations[0].costLotId,'Root');
});
test('archived zero stock ignores stale embedded lot history but becomes visible after real receipt',()=>{
 assert.equal(inventory.isListArchived({listArchived:true,onHand:0,reserved:0,incoming:0,lots:[{qty:10}]}),true);
 assert.equal(inventory.isListArchived({listArchived:true,onHand:1,reserved:0,incoming:0,lots:[{qty:10}]}),false);
});
test('partial arrival cannot relocate a commercial item while later receipts still point to its original warehouse',async()=>{
 const f=fixture();f.docs.get('orders/O').items[0].qty=6;
 await assert.rejects(f.c.commitWarehouseTransfer({id:'T',orderId:'O',itemId:'A',qty:4,toWarehouseId:'EXT'}),/全部到貨/);
 assert.equal(f.docs.has('stockTransfers/T'),false);assert.equal(f.docs.get('warehouseStocks/MAIN__P').onHand,10);
});
test('batch transfer rejects changed destination snapshots and operation-ID collisions',async()=>{
 for(const patch of [{expectedWarehouseId:'OTHER'},{expectedPlan:core.plan({mode:'PICKUP'})}]){
  const f=fixture();await assert.rejects(f.c.commitWarehouseTransfer({id:'T',orderId:'O',itemId:'A',qty:4,toWarehouseId:'EXT',...patch}),/已變更/);
  assert.equal(f.docs.has('stockTransfers/T'),false);assert.equal(f.docs.get('warehouseStocks/MAIN__P').onHand,10);
 }
 const f=fixture();await f.c.commitWarehouseTransfer({id:'T',orderId:'O',itemId:'A',qty:4,toWarehouseId:'EXT'});
 await assert.rejects(f.c.commitWarehouseTransfer({id:'T',orderId:'O',itemId:'OTHER',qty:4,toWarehouseId:'EXT'}),/識別碼衝突/);
});
function batchUiFixture(){
 const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',innerHTML:'',disabled:false,dataset:{},classList:{add(){},remove(){},contains(){return false;}},remove(){}});return nodes.get(id);};
 const p={mode:'CUSTOMER_SHIP',contact:'Customer',phone:'123',address:'台北'};
 const list=[{key:'O__A',order:{id:'O',salesName:'Luke',customerName:'Customer'},item:{itemId:'A',itemCode:'001',deliveryPlan:p},qty:3,warehouseId:'MAIN',warehouse:{id:'MAIN'}},
 {key:'O__B',order:{id:'O',salesName:'Luke',customerName:'Customer'},item:{itemId:'B',itemCode:'002',qty:2,reservedQty:2,deliveryPlan:{mode:'SALES_SHIP',contact:'Sales',phone:'123',address:'高雄'}},qty:2,warehouseId:'MAIN',warehouse:{id:'MAIN'}}];
 const inputs=list.map((r,i)=>({value:String(r.qty),dataset:{batchQty:String(i)},disabled:false})),calls=[],feedback=[];
 const c=vm.createContext({document:{getElementById:node,querySelectorAll:selector=>selector==='[data-batch-qty]'?inputs:[...inputs,node('warehouseShippingBatchDate'),node('warehouseShippingBatchNotes')]},
  canReceiveInventoryCapability:()=>true,canAccessPage:()=>true,currentUser:{uid:'buyer'},currentUserRole:'purchaser',
  orderWorkQueueCache:[],warehouseMasterCache:[{id:'MAIN',warehouseName:'又鑫'}],defaultWarehouse:()=>({id:'MAIN'}),
  YushinInventoryWorkspace:{shippingRows:()=>list},normalizedOrderStatus(){},orderInventorySyncIncomplete(){},normalizedOrderItems(){},itemDispatchState(){},
  loadOrderWorkQueue:async()=>{},loadWarehouseMaster:async()=>{},loadInventory:async()=>{},refreshAffectedOrderCaches:async()=>{},markMainPageDirty(){},inventoryProductKey:()=> 'P',invalidateWarehouseStockCache(){},
  beginActionButton:b=>{b.disabled=true;return {};},endActionButton:b=>{b.disabled=false;},showActionFeedback:(...args)=>feedback.push(args),
  escapeHtml:String,escapeAttr:String,lifecycleRecordId:()=> 'BATCH',localDateString:()=> '2026-10-09'});
 vm.runInContext(src,c);
 c.commitInventoryShipment=async args=>calls.push(['customer',args]);c.commitWarehouseTransfer=async args=>calls.push(['handoff',args]);c.loadWarehouseTransferQueue=async()=>{};
 c.setWarehouseShippingVisibleRows(list);c.selectVisibleWarehouseShipping(true);
 return {c,node,inputs,calls,feedback,list};
}
test('batch UI routes mixed destinations once, applies customer partial quantity and reports completion',async()=>{
 const f=batchUiFixture();await f.c.openWarehouseShippingBatch();
 f.node('warehouseShippingBatchDate').value='2026-10-09';f.node('warehouseShippingBatchNotes').value='物流123';f.inputs[0].value='1';
 await f.c.confirmWarehouseShippingBatch(f.node('confirm'));
 assert.equal(f.calls.length,2);assert.equal(f.calls[0][0],'customer');assert.equal(f.calls[0][1].qty,1);assert.equal(f.calls[0][1].notes,'物流123');
 assert.equal(f.calls[1][0],'handoff');assert.equal(f.calls[1][1].handoff,true);assert.equal(f.calls[1][1].qty,2);
 assert.ok(f.feedback.some(([message])=>/本批 2 個品項已完成/.test(message)));
 await f.c.confirmWarehouseShippingBatch(f.node('confirm'));assert.equal(f.calls.length,2);
});
test('batch UI keeps completed results on error and retries with the same operation ID',async()=>{
 const f=batchUiFixture();let fail=true;f.c.commitWarehouseTransfer=async args=>{f.calls.push(['handoff',args]);if(fail){fail=false;throw Error('network');}};
 await f.c.openWarehouseShippingBatch();f.node('warehouseShippingBatchDate').value='2026-10-09';
 await f.c.confirmWarehouseShippingBatch(f.node('confirm'));
 assert.match(f.node('warehouseShippingBatchRow1').textContent,/network/);assert.match(f.node('warehouseShippingBatchProgress').textContent,/1／2/);
 await f.c.confirmWarehouseShippingBatch(f.node('confirm'));
 assert.equal(f.calls.filter(x=>x[0]==='customer').length,1);assert.equal(f.calls[1][1].id,f.calls[2][1].id);
});
test('order status distinguishes partial delivery, custody and transfers from completed customer shipment',()=>{
 const item={itemId:'A',qty:5,warehouseId:'MAIN'};
 assert.equal(core.shippingStatus({},item,{delivered:2}),'部分已送貨 2／5');
 assert.equal(core.shippingStatus({},item,{delivered:5}),'已送貨');
 assert.equal(core.shippingStatus({},{...item,warehouseId:'custody-S'},{delivered:0}),'已交付負責業務・待送客戶');
 assert.equal(core.shippingStatus({},{...item,transferPendingId:'T'},{delivered:0}),'轉倉途中');
 assert.equal(core.shippingStatus({logisticsHistory:[{itemId:'A',action:'倉庫調撥收貨'}]},item,{delivered:0}),'已轉倉・待送客戶');
 assert.equal(core.shippingStatus({},item,{delivered:0}),'');
});

test('manual unbatched stock can transfer 5 of 10 atomically and retain unknown cost through receipt',async()=>{
 const f=fixture();f.docs.delete('inventoryLots/L');f.docs.delete('inventoryLotCosts/L');
 f.docs.get('warehouseStocks/MAIN__P').reserved=0;f.docs.get('inventory/P').reserved=0;
 const args={id:'NOLOT',inventoryId:'P',fromWarehouseId:'MAIN',toWarehouseId:'EXT',qty:5};
 await f.c.commitWarehouseTransfer(args);await f.c.commitWarehouseTransfer(args);
 assert.equal(f.docs.get('warehouseStocks/MAIN__P').onHand,5);
 assert.equal(f.docs.get('inventory/P').onHand,10);
 assert.equal(f.docs.get('inventory/P').transferInTransit,5);
 const source=f.docs.get('inventoryLots/NOLOT-unbatched-source');
 assert.equal(source.remainingQty,5);assert.equal(source.unbatched,true);assert.equal(source.sourceId,'NOLOT');
 assert.equal(f.docs.has('inventoryLotCosts/NOLOT-unbatched-source'),false);
 await f.c.commitWarehouseTransferReceipt('NOLOT');await f.c.commitWarehouseTransferReceipt('NOLOT');
 assert.equal(f.docs.get('warehouseStocks/EXT__P').onHand,5);
 assert.equal(f.docs.get('inventoryLots/NOLOT-0').remainingQty,5);
 assert.equal(f.docs.get('inventory/P').transferInTransit,0);
 assert.equal(f.docs.get('inventoryLotCosts/NOLOT-0').unitCost,undefined);
 assert.equal(f.docs.get('inventoryLotCosts/NOLOT-0').costSourceLotId,'NOLOT-unbatched-source');
});
test('mixed tracked and unbatched transfer preserves original cost identity and blocks inconsistent totals',async()=>{
 const f=fixture();f.docs.get('inventoryLots/L').remainingQty=2;
 await f.c.commitWarehouseTransfer({id:'MIX',inventoryId:'P',fromWarehouseId:'MAIN',toWarehouseId:'EXT',qty:5});
 const allocations=f.docs.get('stockTransfers/MIX').allocations;
 assert.deepEqual(allocations.map(a=>[a.lotId,a.qty]),[['L',2],['MIX-unbatched-source',3]]);
 assert.equal(allocations[0].costLotId,'L');assert.equal(f.docs.get('inventoryLots/MIX-unbatched-source').remainingQty,5);
 const invalid=fixture();invalid.docs.get('inventoryLots/L').remainingQty=11;
 const before=structuredClone([...invalid.docs]);
 await assert.rejects(invalid.c.commitWarehouseTransfer({id:'BAD',inventoryId:'P',fromWarehouseId:'MAIN',toWarehouseId:'EXT',qty:5}),/超過/);
 assert.deepEqual([...invalid.docs],before);
});
test('unbatched transfer network failure leaves no synthetic lot or stock decrement',async()=>{
 const f=fixture();f.docs.delete('inventoryLots/L');f.fail();const before=structuredClone([...f.docs]);
 await assert.rejects(f.c.commitWarehouseTransfer({id:'FAIL',inventoryId:'P',fromWarehouseId:'MAIN',toWarehouseId:'EXT',qty:5}),/網路/);
 assert.deepEqual([...f.docs],before);
});
test('manual transfer retry cannot reuse an operation ID for another stock or warehouse',async()=>{
 const f=fixture(),args={id:'ID',inventoryId:'P',fromWarehouseId:'MAIN',toWarehouseId:'EXT',qty:3};
 await f.c.commitWarehouseTransfer(args);
 for(const patch of [{inventoryId:'OTHER'},{fromWarehouseId:'EXT'},{toWarehouseId:'OTHER'}])await assert.rejects(f.c.commitWarehouseTransfer({...args,...patch}),/識別碼衝突/);
 assert.equal(f.docs.get('warehouseStocks/MAIN__P').onHand,7);
});
test('branch-to-main transfer preserves final pickup plan through receipt and allows exactly one subsequent handoff',async()=>{
 const f=fixture();const order=f.docs.get('orders/O');order.items[0].deliveryPlan={mode:'PICKUP',warehouseId:'EXT',contact:'Sales'};
 await f.c.commitWarehouseTransfer({id:'MOVE',orderId:'O',itemId:'A',qty:4,toWarehouseId:'EXT',expectedPlan:core.plan(order.items[0].deliveryPlan)});
 assert.equal(f.docs.get('orders/O').items[0].deliveryPlan.mode,'PICKUP');await f.c.commitWarehouseTransferReceipt('MOVE');
 assert.equal(f.docs.get('orders/O').items[0].warehouseId,'EXT');assert.equal(f.docs.get('inventory/P').onHand,10);
 await f.c.commitWarehouseTransfer({id:'HAND',orderId:'O',itemId:'A',qty:4,handoff:true});await f.c.commitWarehouseTransfer({id:'HAND',orderId:'O',itemId:'A',qty:4,handoff:true});
 assert.equal(f.docs.get('warehouseStocks/EXT__P').onHand,0);assert.equal(f.docs.get('warehouseStocks/custody-S__P').onHand,4);assert.equal(f.docs.get('orders/O').deliveryRecords.length,0);
});
test('partial transfer batch preflight blocks all mutations before a customer shipment can be committed',async()=>{
 const f=batchUiFixture();f.list[1].item.qty=5;await f.c.openWarehouseShippingBatch();await f.c.confirmWarehouseShippingBatch(f.node('confirm'));
 assert.equal(f.calls.length,0);assert.ok(f.feedback.some(([message])=>/全部到貨/.test(message)));
});
function mainRequestFixture(options={}){
 const f=fixture(options);f.docs.get('warehouses/MAIN').isDefault=true;
 f.docs.set('warehouseStocks/EXT__P',{productKey:'P',warehouseId:'EXT',onHand:6,reserved:0,incoming:0});
 f.docs.set('inventoryLots/EXTLOT',{productKey:'P',warehouseId:'EXT',remainingQty:6,qty:6,lotNo:'EXTLOT',expiryDate:'2027-01-01'});
 f.docs.get('inventory/P').onHand=16;
 Object.assign(f.c,{canManageInventoryStockPolicy:()=>['admin','purchaser'].includes(f.c.currentUserRole),canEditPage:()=>true,confirm:()=>true,beginActionButton:()=>({}),endActionButton:()=>{},showActionFeedback:()=>{},loadInventory:async()=>{}});
 f.c.YushinReservation=require('../modules/reservation-core');
 vm.runInContext(fs.readFileSync('src/services/main-transfer-request.js','utf8'),f.c);
 vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../modules/main-warehouse-transfers.js'),'utf8'),f.c);
 f.c.loadMainTransferRequests=async()=>{};f.c.loadWarehouseTransferQueue=async()=>{};
 return f;
}
test('main replenishment reserves free branch stock once; dispatch and receipt preserve company quantity without a customer reservation',async()=>{
 const f=mainRequestFixture(),args={id:'REQ',inventoryId:'P',fromWarehouseId:'EXT',qty:3};
 await f.c.createMainTransferRequest(args);await f.c.createMainTransferRequest(args);
 assert.equal(f.docs.get('warehouseStocks/EXT__P').onHand,6);assert.equal(f.docs.get('warehouseStocks/EXT__P').reserved,3);
 assert.equal(f.docs.get('inventory/P').reserved,7);assert.equal(f.docs.get('inventoryLots/EXTLOT').remainingQty,6);
 assert.equal(f.docs.get('stockTransferRequests/REQ').status,'PENDING');assert.equal(f.docs.has('stockTransfers/SEND'),false);
 await assert.rejects(f.c.createMainTransferRequest({...args,id:'OVER',qty:4}),/不足/);
 await f.c.commitWarehouseTransfer({id:'SEND',requestId:'REQ',inventoryId:'P',fromWarehouseId:'EXT',toWarehouseId:'MAIN',qty:3});
 await f.c.commitWarehouseTransfer({id:'SEND',requestId:'REQ',inventoryId:'P',fromWarehouseId:'EXT',toWarehouseId:'MAIN',qty:3});
 assert.equal(f.docs.get('stockTransferRequests/REQ').status,'SHIPPED');assert.equal(f.docs.get('warehouseStocks/EXT__P').onHand,3);
 assert.equal(f.docs.get('warehouseStocks/EXT__P').reserved,0);assert.equal(f.docs.get('inventory/P').reserved,4);
 assert.equal(f.docs.get('inventory/P').transferReserved,0);assert.equal(inventory.normalizeStock(f.docs.get('inventory/P')).available,9);
 await assert.rejects(f.c.commitWarehouseTransfer({id:'OTHER',requestId:'REQ',inventoryId:'P',fromWarehouseId:'EXT',toWarehouseId:'MAIN',qty:3}),/已變更/);
 await f.c.commitWarehouseTransferReceipt('SEND');await f.c.commitWarehouseTransferReceipt('SEND');
 assert.equal(f.docs.get('warehouseStocks/MAIN__P').onHand,13);assert.equal(f.docs.get('warehouseStocks/MAIN__P').reserved,4);
 assert.equal(f.docs.get('inventory/P').onHand,16);assert.equal(inventory.normalizeStock(f.docs.get('inventory/P')).available,12);
 assert.equal(f.docs.get('inventoryReservations/O__A').quantity,4);assert.equal(f.docs.get('orders/O').items[0].warehouseId,'MAIN');
});
test('cancelling a pending replenishment releases its hold once, preserves order stock and rejects warehouse request creation',async()=>{
 const f=mainRequestFixture();await f.c.createMainTransferRequest({id:'REQ',inventoryId:'P',fromWarehouseId:'EXT',qty:2});
 await f.c.cancelMainTransferRequest('REQ',{});await f.c.cancelMainTransferRequest('REQ',{});
 assert.equal(f.docs.get('stockTransferRequests/REQ').status,'CANCELLED');assert.equal(f.docs.get('warehouseStocks/EXT__P').reserved,0);
 assert.equal(f.docs.get('inventory/P').reserved,4);assert.equal(f.docs.get('inventory/P').transferReserved,0);
 await assert.rejects(f.c.commitWarehouseTransfer({id:'SEND',requestId:'REQ',inventoryId:'P',fromWarehouseId:'EXT',toWarehouseId:'MAIN',qty:2}),/已變更/);
 f.c.currentUserRole='warehouse';await assert.rejects(f.c.createMainTransferRequest({id:'BAD',inventoryId:'P',fromWarehouseId:'EXT',qty:1}),/採購/);
});
test('main replenishment cannot reserve company free stock already in transit even when the branch appears sufficient',async()=>{
 const f=mainRequestFixture();f.docs.get('inventory/P').transferFreeInTransit=10;
 const before=structuredClone([...f.docs]);
 await assert.rejects(f.c.createMainTransferRequest({id:'OVER',inventoryId:'P',fromWarehouseId:'EXT',qty:3}),/可用庫存不足/);
 assert.deepEqual([...f.docs],before);
});
test('main request service retries reserve and release once; cancelled request IDs never reopen',async()=>{
 const f=mainRequestFixture({retry:true}),args={id:'REQ',inventoryId:'P',fromWarehouseId:'EXT',qty:2};
 await f.c.createMainTransferRequest(args);await f.c.createMainTransferRequest(args);
 assert.equal(f.docs.get('inventory/P').reserved,6);
 await f.c.cancelMainTransferRequestRecord('REQ');await f.c.cancelMainTransferRequestRecord('REQ');
 const replay=await f.c.createMainTransferRequest(args);
 assert.equal(replay.status,'CANCELLED');assert.equal(f.docs.get('inventory/P').reserved,4);
 assert.equal(f.docs.get('warehouseStocks/EXT__P').transferReserved,0);
});
test('inconsistent cancellation or a failed commit leaves both stock holds and request status unchanged',async()=>{
 for(const kind of ['short-hold','commit']){
  const f=mainRequestFixture();await f.c.createMainTransferRequest({id:'REQ',inventoryId:'P',fromWarehouseId:'EXT',qty:2});
  if(kind==='short-hold')f.docs.get('warehouseStocks/EXT__P').transferReserved=1;else f.fail();
  const before=structuredClone([...f.docs]);
  await assert.rejects(f.c.cancelMainTransferRequestRecord('REQ'));
  assert.deepEqual([...f.docs],before);assert.equal(f.docs.get('stockTransferRequests/REQ').status,'PENDING');
 }
});
test('shipped requests and non-purchasing roles cannot release main replenishment holds',async()=>{
 const f=mainRequestFixture();await f.c.createMainTransferRequest({id:'REQ',inventoryId:'P',fromWarehouseId:'EXT',qty:2});
 await f.c.commitWarehouseTransfer({id:'SEND',requestId:'REQ',inventoryId:'P',fromWarehouseId:'EXT',toWarehouseId:'MAIN',qty:2});
 const before=JSON.stringify([...f.docs]);
 await assert.rejects(f.c.cancelMainTransferRequestRecord('REQ'),/已寄出/);
 f.c.currentUserRole='warehouse';await assert.rejects(f.c.cancelMainTransferRequestRecord('REQ'),/採購/);
 assert.equal(JSON.stringify([...f.docs]),before);
});
test('cancelled request stays successfully cancelled when refreshing the UI fails',async()=>{
 const f=mainRequestFixture(),messages=[];await f.c.createMainTransferRequest({id:'REQ',inventoryId:'P',fromWarehouseId:'EXT',qty:2});
 f.c.loadMainTransferRequests=async()=>{throw Error('offline');};f.c.showActionFeedback=message=>messages.push(message);
 await f.c.cancelMainTransferRequest('REQ',{});
 assert.equal(f.docs.get('stockTransferRequests/REQ').status,'CANCELLED');
 assert.equal(f.docs.get('inventory/P').reserved,4);
 assert.match(messages[0],/已取消.*清單更新失敗/);assert.doesNotMatch(messages[0],/取消未完成/);
});
test('only explicit main pickup generates an order return-to-main requirement; recipient warehouse hints and missing mode do not reroute shipments',()=>{
 const warehouses=[{id:'MAIN'},{id:'EXT'}],helpers={status:()=> 'normal',incomplete:()=>false,items:o=>o.items,dispatch:(_o,i)=>({shippable:i.qty})};
 const row={warehouseId:'EXT',item:{},order:{}};
 for(const mode of ['', 'SALES_SHIP','CUSTOMER_SHIP']){
  const value={mode,warehouseId:'MAIN',contact:'R',phone:'P',address:'A'};
  assert.equal(core.executionPlan({...row,item:{deliveryPlan:value}},warehouses,'MAIN').mode,mode);
  assert.equal(core.transferRequirements([{id:mode||'missing',items:[{itemId:'A',warehouseId:'EXT',qty:2,deliveryPlan:value}]}],warehouses,'MAIN',helpers).length,0);
 }
 assert.equal(core.transferRequirements([{id:'pickup',items:[{itemId:'A',warehouseId:'EXT',qty:2,reservedQty:2,deliveryPlan:{mode:'PICKUP'}}]}],warehouses,'MAIN',helpers).length,1);
 assert.throws(()=>core.validatePlan({}),/交付|主倉/);
});
test('warehouse shipping batch refuses main pickup even when a stale selection includes it',async()=>{
 const f=batchUiFixture();f.list[1].item.deliveryPlan={mode:'PICKUP'};
 await f.c.openWarehouseShippingBatch();await f.c.confirmWarehouseShippingBatch(f.node('confirm'));
 assert.equal(f.calls.length,0);assert.ok(f.feedback.some(([text])=>/變更|重新勾選/.test(text)));
});
test('business delivery is enabled only for main pickup or goods already mailed to the salesperson',()=>{
 const state={reserved:3,prepared:3,shippable:3,pending:0};
 assert.equal(core.businessDeliveryState({}, {warehouseId:'MAIN',deliveryPlan:{mode:'PICKUP'}},state,'MAIN').shippable,3);
 assert.equal(core.businessDeliveryState({}, {warehouseId:'EXT',deliveryPlan:{mode:'PICKUP'}},state,'MAIN').deliveryWait,'待調回主倉');
 assert.equal(core.businessDeliveryState({}, {warehouseId:'MAIN',deliveryPlan:{mode:'SALES_SHIP'}},state,'MAIN').shippable,0);
 assert.equal(core.businessDeliveryState({}, {warehouseId:'custody-S',deliveryPlan:{mode:'SALES_SHIP'}},state,'MAIN').shippable,3);
 assert.equal(core.businessDeliveryState({}, {warehouseId:'EXT',deliveryPlan:{mode:'CUSTOMER_SHIP'}},state,'MAIN').shippable,0);
 assert.equal(core.businessDeliveryState({}, {warehouseId:'EXT',fulfillmentType:'DIRECT_SHIP'},state,'MAIN'),state);
});

test('multi-warehouse batch checks one shared dispatch allowance before submitting any row',async()=>{
 const f=batchUiFixture(),first=f.list[0],second=f.list[1];
 first.located=true;first.key='O__A__MAIN';second.located=true;second.key='O__A__OTHER';
 second.item={...first.item};second.warehouseId='OTHER';second.warehouse={id:'OTHER'};second.qty=5;
 f.inputs[0].value='3';f.inputs[1].value='5';f.c.itemDispatchState=()=>({shippable:5});
 f.c.clearWarehouseShippingSelection();f.c.setWarehouseShippingVisibleRows(f.list);f.c.selectVisibleWarehouseShipping(true);
 await f.c.openWarehouseShippingBatch();f.node('warehouseShippingBatchDate').value='2026-10-21';
 await f.c.confirmWarehouseShippingBatch(f.node('confirm'));
 assert.equal(f.calls.length,0);assert.ok(f.feedback.some(([m])=>/合計超過/.test(m)));
 f.inputs[1].value='2';await f.c.confirmWarehouseShippingBatch(f.node('confirm'));
 assert.equal(f.calls.length,2);assert.equal(f.calls[0][1].expectedWarehouseId,'MAIN');assert.equal(f.calls[1][1].expectedWarehouseId,'OTHER');
 assert.deepEqual(f.calls.map(row=>row[1].qty),[3,2]);
});

test('shared transfer lots preserve original cost references, fractional quantities and custody destinations',()=>{
 const transfer={id:'T',productKey:'P',productId:'PRODUCT',toWarehouseId:'custody-U',qty:1.5,itemCode:'OLD',itemName:'Name',
  allocations:[{lotId:'SOURCE',targetLotId:'T-0',costLotId:'ORIGINAL-COST',qty:1.5,lotNo:'LOT',expiryDate:'2027-01-01',unbatched:true}]};
 const before=structuredClone(transfer),rows=core.transferDestinationLots(transfer,{itemCode:'NEW'},'2026-10-29');
 assert.deepEqual(transfer,before);assert.equal(rows.length,1);assert.equal(rows[0].lot.remainingQty,1.5);
 assert.equal(rows[0].lot.warehouseId,'custody-U');assert.equal(rows[0].lot.itemCode,'NEW');assert.equal(rows[0].lot.unbatched,true);
 assert.equal(rows[0].lot.costLotId,'ORIGINAL-COST');assert.equal(rows[0].cost.costSourceLotId,'ORIGINAL-COST');
 assert.equal('unitCost' in rows[0].cost,false);assert.equal('cost' in rows[0].lot,false);
 const changed=core.transferDestinationLots({...transfer,toWarehouseId:'MAIN'},transfer,'2026-10-29');assert.equal(changed[0].lot.lotNo,'LOT');assert.equal(changed[0].lot.expiryDate,'2027-01-01');
});
test('shared transfer lots validate all sources before exposing any destination writes',()=>{
 const transfer={id:'T',productKey:'P',toWarehouseId:'MAIN',qty:2,allocations:[{lotId:'A',targetLotId:'T-0',costLotId:'C',qty:2}]};
 for(const patch of [{qty:3},{allocations:[]},{allocations:[{...transfer.allocations[0],targetLotId:'OTHER'}]},
  {allocations:[{...transfer.allocations[0],costLotId:'bad/id'}]},
  {qty:4,allocations:[transfer.allocations[0],{...transfer.allocations[0],targetLotId:'T-1'}]},
  {allocations:[{...transfer.allocations[0],qty:NaN}]}])assert.throws(()=>core.transferDestinationLots({...transfer,...patch},{},'date'));
});

test('legacy transfer rejects a mixed or v2 reservation without partially moving stock or lots',async()=>{
 for(const mixed of [false,true]){
  const f=fixture(),ledger=f.docs.get('inventoryReservations/O__A');
  Object.assign(ledger,{locationSchemaVersion:2,locations:[{warehouseId:'MAIN',reservedQty:4}]});if(!mixed)delete ledger.warehouseId;
  const before=JSON.stringify([...f.docs]);
  await assert.rejects(f.c.commitWarehouseTransfer({id:'V2-BLOCK',orderId:'O',itemId:'A',qty:4,toWarehouseId:'EXT'}),/多倉/);
  assert.equal(JSON.stringify([...f.docs]),before);
 }
});
