const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const inventory=require('../modules/inventory-core');
const service=fs.readFileSync('src/services/manual-inventory.js','utf8'),feature=fs.readFileSync('src/features/inventory/inventory-workspace.js','utf8');
const plain=x=>JSON.parse(JSON.stringify(x));
function fixture({role='purchaser',type='initial',qty=3,lotNo='B',unitCost=0}={}){
 const docs=new Map([['products/P',{productId:'P',productName:'Product',manufacturerPartNo:'CODE',brandName:'Qiagen',active:true}],['warehouses/W',{active:true}],
  ['inventory/P',{productKey:'P',productId:'P',onHand:10,reserved:2,incoming:0}],['warehouseStocks/W__P',{productKey:'P',productId:'P',warehouseId:'W',onHand:10,reserved:2,incoming:0}],
  ['inventoryLots/L',{productKey:'P',productId:'P',warehouseId:'W',lotNo:'B',expiryDate:'2027-01-01',receivedQty:10,remainingQty:10,sourceType:'SUPPLY_ORDER',sourceId:'S'}]]);
 const state={fail:false,lost:false,replay:false,afterRead:null,afterCommit:null,querySize:null},reads=[],writes=[],notifications=[];
 const ref=(col,id)=>({id,path:col+'/'+id});
 const c=vm.createContext({currentUser:{uid:'U'},currentUserRole:role,currentUserName:'User',YushinInventory:inventory,
  warehouseStockDocId:(w,p)=>w+'__'+p,firestoreReadWithTimeout:p=>p,resolveBrandName:b=>b,brandIdForName:()=> 'QIAGEN',buildInventorySearchTokens:()=>[],
  db:{collection:col=>({doc:id=>ref(col,id),where:(field,_op,value)=>({limit:limit=>({get:async()=>{
   assert.equal(limit,201);const found=[...docs].filter(([p,d])=>p.startsWith(col+'/')&&d[field]===value).slice(0,limit);
   return {size:state.querySize??found.length,docs:found.map(([p])=>({ref:ref(col,p.split('/')[1])}))};
  }})})})},
  runRoleTransaction:async fn=>{
   let staged=[];const tx={get:async r=>{if(staged.length)throw Error('read after write');reads.push(r.path);const data=docs.get(r.path);state.afterRead?.(r);return {id:r.id,exists:!!data,data:()=>plain(data)};},
    set:(r,d,o)=>staged.push([r.path,plain(d),!!o?.merge]),update:(r,d)=>staged.push([r.path,plain(d),true])};
   if(state.replay){await fn(tx);staged=[];}await fn(tx);if(state.fail)throw Error('commit rejected');
   for(const [path,data,merge] of staged){
    if(data.adjustmentIntent)data.adjustmentIntent=Object.fromEntries(Object.entries(data.adjustmentIntent).sort(([a],[b])=>a.localeCompare(b)));
    docs.set(path,{...(merge?docs.get(path):{}),...data});writes.push(path);
   }
   state.afterCommit?.();if(state.lost){state.lost=false;throw Error('lost reply');}
  }});
 vm.runInContext(service,c);
 const request={type,productKey:'P',warehouseId:'W',operationId:'OP',row:{itemCode:'CODE',itemName:'stale name',qty,unitCost,lotNo,expiryDate:'2027-01-01'}};
 return {c,docs,state,reads,writes,notifications,request,run:(r=request,options={})=>c.commitManualInventoryAdjustment(r,{onStockCommitted:(...args)=>notifications.push(args),...options})};
}
test('manual Service uniquely owns writes and Feature contains no inventory transaction',()=>{
 const handler=feature.slice(feature.indexOf('window.saveInventoryAdjustmentBatch ='),feature.indexOf('function inventoryProductKey'));
 assert.match(handler,/commitManualInventoryAdjustment/);assert.doesNotMatch(handler,/runRoleTransaction|db\.collection|tx\.(?:set|update)/);
 assert.doesNotMatch(service,/\b(?:window|document|localStorage|sessionStorage|priceList|warehouseMasterCache|invalidateWarehouseStockCache)\b/);
 assert.match(service,/YushinInventory\.manualAdjustmentLots/);
});
test('initial stock atomically adds protected zero cost and master metadata while preserving original receipts',async()=>{
 const f=fixture();await f.run();assert.equal(f.docs.get('inventory/P').onHand,13);assert.equal(f.docs.get('warehouseStocks/W__P').onHand,13);
 assert.equal(f.docs.get('inventory/P').itemName,'Product');assert.equal(f.docs.get('inventory/P').brand,'Qiagen');
 assert.equal(f.docs.get('inventoryLots/L').remainingQty,10);assert.equal(f.docs.get('inventoryLots/OP-added').remainingQty,3);
 assert.equal(f.docs.get('inventoryLots/OP-added').sourceType,'INITIAL_STOCK');assert.equal(f.docs.get('inventoryLots/OP-added').unitCost,undefined);
 assert.equal(f.docs.get('inventoryLotCosts/OP-added').unitCost,0);assert.equal(f.docs.get('inventoryMovements/OP').unitCost,undefined);
 const paid=fixture({unitCost:123});await paid.run();assert.equal(paid.docs.get('inventoryLotCosts/OP-added').unitCost,123);
 assert.equal(JSON.stringify(paid.docs.get('inventoryMovements/OP')).includes('123'),false);
});
test('warehouse initial stock records pending cost without reading or disclosing protected cost',async()=>{
 const f=fixture({role:'warehouse',unitCost:''});await f.run();assert.equal(f.docs.get('inventoryLotCosts/OP-added').costPending,true);
 await f.run();assert.equal(f.reads.some(p=>p.startsWith('inventoryLotCosts/')),false);
 assert.equal(f.docs.get('inventoryLotCosts/OP-added').unitCost,undefined);
});
test('positive adjustment creates an operational lot without inventing acquisition cost',async()=>{
 const f=fixture({type:'adjustment'});await f.run();assert.equal(f.docs.get('inventoryLots/OP-added').sourceType,'MANUAL_ADJUSTMENT');
 assert.equal(f.docs.has('inventoryLotCosts/OP-added'),false);assert.equal(f.docs.get('inventory/P').lots.reduce((s,l)=>s+l.qty,0),13);
});
test('negative adjustment and scrap reduce selected authoritative lots while preserving their receipt identity',async()=>{
 for(const [type,qty] of [['adjustment',-3],['scrap',3],['scrap',-3]]){
  const f=fixture({type,qty});await f.run();assert.equal(f.docs.get('inventoryLots/L').remainingQty,7);assert.equal(f.docs.get('inventoryLots/L').sourceId,'S');
  assert.equal(f.docs.get('inventory/P').onHand,7);assert.equal(f.docs.get('inventoryMovements/OP').lotAllocations[0].lotId,'L');
 }
});
test('manual replay after lost reply does not add or deduct twice or overwrite later stock',async()=>{
 for(const [type,qty] of [['initial',3],['adjustment',-3],['scrap',3]]){
  const f=fixture({type,qty});f.state.lost=true;await assert.rejects(f.run(),/lost reply/);
  f.docs.get('inventory/P').onHand+=5;f.docs.get('warehouseStocks/W__P').onHand+=5;
  const before=JSON.stringify([...f.docs]),count=f.writes.length;f.reads.length=0;assert.equal((await f.run()).replayed,true);
  assert.equal(JSON.stringify([...f.docs]),before);assert.equal(f.writes.length,count);
  assert.deepEqual(f.reads,type==='initial'?['inventoryMovements/OP','inventoryLotCosts/OP-added']:['inventoryMovements/OP']);
 }
});
test('manual callback replay freezes identity time and emits only one postcommit notification',async()=>{
 const f=fixture();f.state.replay=true;await f.run();assert.equal(f.writes.filter(p=>p.startsWith('inventoryMovements/')).length,1);
 assert.deepEqual(f.notifications,[['P','W']]);assert.equal(f.docs.get('inventory/P').updatedAt,f.docs.get('inventoryMovements/OP').createdAt);
});
test('manual commit snapshots payload and existing-ID recovery does not need live master or UI product cache',async()=>{
 const f=fixture();f.state.afterRead=()=>{f.request.row.qty=99;f.request.row.unitCost=99;};await f.run();
 assert.equal(f.docs.get('inventory/P').onHand,13);assert.equal(f.docs.get('inventoryLotCosts/OP-added').unitCost,0);
 f.state.afterRead=null;f.request.row.qty=3;f.request.row.unitCost=0;f.docs.delete('products/P');f.docs.delete('warehouses/W');
 assert.equal((await f.run()).replayed,true);
});
test('same ID rejects changed quantity batch expiry kind actor and protected cost',async()=>{
 for(const change of [f=>f.request.row.qty=4,f=>f.request.row.lotNo='OTHER',f=>f.request.row.expiryDate='2028-01-01',f=>f.request.type='adjustment',
  f=>f.c.currentUser={uid:'OTHER'},f=>f.c.currentUserRole='admin',f=>f.request.row.unitCost=10]){
  const f=fixture();await f.run();const before=JSON.stringify([...f.docs]);change(f);await assert.rejects(f.run());assert.equal(JSON.stringify([...f.docs]),before);
 }
});
test('invalid source stock batch or reservations leave every collection unchanged',async()=>{
 for(const change of [f=>f.docs.delete('products/P'),f=>f.docs.get('products/P').active=false,f=>f.docs.get('products/P').lotTracked=true,f=>f.docs.get('products/P').productType='Service',
  f=>f.docs.delete('warehouses/W'),f=>f.docs.get('warehouses/W').active=false,f=>f.docs.get('warehouses/W').systemCustody=true,
  f=>f.docs.get('inventory/P').onHand=-1,f=>f.docs.get('inventory/P').reserved='bad',f=>f.docs.get('warehouseStocks/W__P').incoming='',
  f=>f.docs.get('warehouseStocks/W__P').productKey='OTHER',f=>f.docs.get('inventoryLots/L').remainingQty=11,
  f=>f.docs.get('inventoryLots/L').remainingQty=-1,f=>f.state.querySize=201,
  f=>f.docs.set('inventoryLots/OP-added',{productKey:'OTHER',remainingQty:1})]){
  const f=fixture({lotNo:''});change(f);const before=JSON.stringify([...f.docs]);await assert.rejects(f.run());assert.equal(JSON.stringify([...f.docs]),before);assert.equal(f.writes.length,0);
 }
 const reserved=fixture({type:'scrap',qty:9});await assert.rejects(reserved.run(),/預留/);assert.equal(reserved.writes.length,0);
 const wrongBatch=fixture({type:'scrap',lotNo:'MISSING'});await assert.rejects(wrongBatch.run(),/不足/);assert.equal(wrongBatch.writes.length,0);
});
test('invalid inputs and unauthorized roles never start a transaction',async()=>{
 for(const change of [f=>f.request.row.qty=0,f=>f.request.row.qty=Infinity,f=>f.request.row.qty=-1,f=>f.request.row.unitCost='',
  f=>f.request.row.unitCost=-1,f=>f.request.row.expiryDate='2027-02-30',f=>f.request.operationId='a/b',f=>f.c.currentUserRole='sales',f=>f.c.currentUserRole='engineer']){
  const f=fixture();change(f);await assert.rejects(f.run());assert.equal(f.reads.length,0);
 }
});
test('commit failure and midread account switch preserve all data',async()=>{
 for(const change of [f=>f.state.fail=true,f=>f.state.afterRead=()=>{f.c.currentUser={uid:'OTHER'};}]){
  const f=fixture();change(f);const before=JSON.stringify([...f.docs]);await assert.rejects(f.run());assert.equal(JSON.stringify([...f.docs]),before);
 }
});
test('postcommit observer or role switch error marks committed and replay keeps original facts',async()=>{
 for(const mode of ['observer','role']){
  const f=fixture();if(mode==='role')f.state.afterCommit=()=>{f.c.currentUserRole='admin';};
  await assert.rejects(f.run(f.request,{onStockCommitted:()=>{throw Error('cache failed');}}),e=>e.manualAdjustmentCommitted&&e.operationId==='OP');
  f.state.afterCommit=null;f.c.currentUserRole='purchaser';const before=JSON.stringify([...f.docs]);await f.run();assert.equal(JSON.stringify([...f.docs]),before);
 }
});
test('legacy list mirror derives from current lots in all warehouses instead of applying an independent delta',async()=>{
 const f=fixture();f.docs.set('inventoryLots/EXT',{productKey:'P',warehouseId:'EXT',lotNo:'OTHER',remainingQty:2});f.docs.get('inventory/P').onHand=12;
 f.docs.get('inventory/P').lots=[{lotNo:'stale',qty:-100}];await f.run();const mirror=f.docs.get('inventory/P').lots;
 assert.equal(mirror.some(l=>l.lotNo==='stale'),false);assert.equal(mirror.reduce((s,l)=>s+l.qty,0),15);assert.equal(f.docs.get('inventoryLots/EXT').remainingQty,2);
});
function batchFixture(){
 const f=fixture(),c=f.c,messages=[],button={};let sequence=0;
 Object.assign(c,{inventoryAdjustmentSaveInProgress:false,inventoryAdjustmentGeneration:1,inventoryAdjustmentRows:[{...f.request.row,productId:'P',warehouseId:'W'},{...f.request.row,productId:'P',warehouseId:'W'}],
  document:{getElementById:id=>id==='inventoryAdjustmentType'?{value:'initial'}:button},canEditPage:()=>true,canCreatePurchaseOrderCapability:()=>true,
  lifecycleRecordId:()=> 'BATCH-'+(++sequence),priceList:[{productId:'P'}],findPriceItemByCodeValue:()=>null,stableProductId:x=>x.productId,
  invalidateWarehouseStockCache:(...args)=>f.notifications.push(args),loadInventory:async()=>{},renderInventoryAdjustmentRows(){},
  closeInventoryAdjustment:()=>{c.inventoryAdjustmentGeneration++;},alert:m=>messages.push(m),console:{error(){}}});
 c.window=c;vm.runInContext(feature.slice(feature.indexOf('window.saveInventoryAdjustmentBatch ='),feature.indexOf('function inventoryProductKey')),c);
 return {...f,messages,button};
}
test('batch partial success removes confirmed rows and retries lost response with the same ID',async()=>{
 const f=batchFixture(),original=f.c.commitManualInventoryAdjustment;let uncertain=true;
 f.c.commitManualInventoryAdjustment=async(request,options)=>{if(request.operationId==='BATCH-2'&&uncertain){uncertain=false;f.state.lost=true;}return original(request,options);};
 await f.c.saveInventoryAdjustmentBatch();assert.equal(f.c.inventoryAdjustmentRows.length,1);assert.equal(f.c.inventoryAdjustmentRows[0].operationId,'BATCH-2');
 assert.equal(f.docs.get('inventory/P').onHand,16);await f.c.saveInventoryAdjustmentBatch();assert.equal(f.docs.get('inventory/P').onHand,16);
 assert.equal(f.button.disabled,false);assert.match(f.messages.at(-1),/已完成 1 筆/);
});
test('batch blocks duplicate submission and stops remaining rows and cache after actor switch',async()=>{
 const f=batchFixture();let release;const gate=new Promise(r=>release=r),original=f.c.commitManualInventoryAdjustment;let calls=0;
 f.c.commitManualInventoryAdjustment=async(...args)=>{calls++;await gate;return original(...args);};
 const pending=f.c.saveInventoryAdjustmentBatch();await f.c.saveInventoryAdjustmentBatch();assert.equal(calls,1);release();await pending;assert.equal(calls,2);
 const switched=batchFixture();switched.state.afterCommit=()=>{switched.c.currentUser={uid:'OTHER'};};await switched.c.saveInventoryAdjustmentBatch();
 assert.equal(switched.docs.get('inventory/P').onHand,13);assert.equal(switched.notifications.length,0);assert.equal(switched.messages.length,0);assert.equal(switched.c.inventoryAdjustmentRows.length,2);
});
