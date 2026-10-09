const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const core=require('../modules/warehouse-logistics'),inventory=require('../modules/inventory-core'),fulfillment=require('../modules/fulfillment-core'),workspace=require('../modules/inventory-workspace');
const src=fs.readFileSync('modules/warehouse-logistics.js','utf8');
test('recipient validation and grouping separate warehouse, destination and shipping conditions',()=>{
 assert.throws(()=>core.validatePlan({mode:'SALES_SHIP'},true),/收件人/);
 assert.throws(()=>core.validatePlan({mode:'TRANSFER',warehouseId:''}),/倉庫/);
 for(const packages of [0,-1,1.5,100])assert.throws(()=>core.validatePlan({packages}));
 const p={mode:'CUSTOMER_SHIP',contact:'A',phone:'123',address:'台北',condition:'冷藏'};
 const rows=[{warehouseId:'MAIN',p},{warehouseId:'MAIN',p},{warehouseId:'MAIN',p:{...p,address:'台南'}},{warehouseId:'MAIN',p:{...p,condition:'常溫'}},{warehouseId:'EXT',p}];
 const groups=core.partition(rows,r=>r.p);assert.equal(groups.length,4);assert.equal(groups[0].rows.length,2);
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
 assert.ok(csv.startsWith('\uFEFF'));assert.match(csv,/"00123"/);assert.match(csv,/"台北,""二樓"""/);assert.match(csv,/"'\=SUM\(A1\)"/);assert.match(csv,/"冷凍"/);assert.match(csv,/"請電聯\n到貨"/);
});
function fixture(){
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
 const c=vm.createContext({currentUser:{uid:'buyer'},currentUserRole:'purchaser',currentUserName:'Buyer',currentUserCode:'P01',warehouseMasterCache:[{id:'MAIN',active:true},{id:'EXT',active:true}],
   canReceiveInventoryCapability:()=>true,canAccessPage:()=>true,deliveryActor:()=> 'Buyer',defaultWarehouse:()=>({id:'MAIN'}),
   inventoryRefFor:i=>ref('inventory',i.productId),warehouseStockDocId:(w,p)=>w+'__'+p,
   normalizedOrderStatus:o=>o.status==='cancelled'?'cancelled':'normal',orderInventorySyncIncomplete:()=>false,
   normalizedOrderItems:o=>o.items,inventoryProductKey:i=>i.productId,
   itemDispatchState:(_o,i)=>fulfillment.dispatchState(i),orderWorkIndexFields:()=>({workCategories:['delivery']}),
   firestoreReadWithTimeout:async p=>p,YushinInventory:inventory,YushinWarehouseLogistics:core,
   firebase:{firestore:{FieldValue:{arrayUnion:v=>({union:v})}}},
   db:{collection:col=>({doc:id=>ref(col,id),where(field,_op,value){const predicates=[[field,value]];const query={where(f,_o,v){predicates.push([f,v]);return query;},limit(){return query;},get:async()=>{const result=[...docs.entries()].filter(([path,data])=>path.startsWith(col+'/')&&predicates.every(([f,v])=>data[f]===v)).map(([path,data])=>({id:path.split('/')[1],ref:ref(col,path.split('/')[1]),exists:true,data:()=>structuredClone(data)}));return {docs:result,size:result.length};}};return query;}})},
   runRoleTransaction:async fn=>{
    const writes=[];const tx={get:async r=>({id:r.id,ref:r,exists:docs.has(r.path),data:()=>structuredClone(docs.get(r.path))}),update:(r,d)=>writes.push([r,d,true]),set:(r,d,options)=>writes.push([r,d,!!options?.merge])};
    await fn(tx);if(failCommit)throw Error('網路中斷');
    for(const [r,data,merge] of writes){const base=merge?docs.get(r.path)||{}:{};const d={...data};for(const [key,value] of Object.entries(d))if(value?.union)d[key]=[...(base[key]||[]),value.union];docs.set(r.path,{...base,...d});}commits+=1;
   }
 });
 vm.runInContext(src,c);return {c,docs,ref,fail:()=>{failCommit=true;},commits:()=>commits};
}
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
 {key:'O__B',order:{id:'O',salesName:'Luke',customerName:'Customer'},item:{itemId:'B',itemCode:'002',deliveryPlan:{mode:'PICKUP'}},qty:2,warehouseId:'MAIN',warehouse:{id:'MAIN'}}];
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
 assert.equal(core.shippingStatus({},{...item,warehouseId:'custody-S'},{delivered:0}),'已交付業務・待送客戶');
 assert.equal(core.shippingStatus({},{...item,transferPendingId:'T'},{delivered:0}),'轉倉途中');
 assert.equal(core.shippingStatus({logisticsHistory:[{itemId:'A',action:'倉庫調撥收貨'}]},item,{delivered:0}),'已轉倉・待送客戶');
 assert.equal(core.shippingStatus({},item,{delivered:0}),'');
});
