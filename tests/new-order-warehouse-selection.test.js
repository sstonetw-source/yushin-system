const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const core=require('../modules/reservation-core');
const inventory=require('../modules/inventory-core');
const start=app.indexOf('function orderDraftStorageKey()');
const end=app.indexOf('function orderDraftFieldValue(',start);
const rs=app.indexOf('async function reserveSingleOrderItem(');
const re=app.indexOf('function orderReservationSummary(',rs);
assert.ok(start>=0&&end>start&&rs>=0&&re>rs);

function setup(stockRows){
 const docs=new Map(Object.entries(stockRows||{}));
 const memory=new Map();
 let sequence=0;
 const db={
  collection:name=>({doc:id=>({path:name+'/'+(id||('auto-'+(++sequence))),id:id||'auto-'+sequence})}),
  async runTransaction(fn){
   const writes=[];
   const tx={
    get:async ref=>({exists:docs.has(ref.path),data:()=>structuredClone(docs.get(ref.path))}),
    set:(ref,data,options)=>writes.push([ref.path,data,!!options?.merge]),
    update:(ref,data)=>writes.push([ref.path,data,true])
   };
   await fn(tx);
   for(const [key,data,merge] of writes)docs.set(key,merge?{...docs.get(key),...data}:data);
  }
 };
 const context=vm.createContext({
  db,
  ORDER_DRAFT_STORAGE_PREFIX:'draft',
  currentUser:{uid:'U1'},currentUserCode:'S01',currentUserName:'業務',
  BUSINESS_STATUS:{ACTIVE:'active'},
  localStorage:{getItem:key=>memory.get(key)||null,setItem:(key,val)=>memory.set(key,val)},
  warehouseMasterCache:[{id:'MAIN',active:true},{id:'EXT',active:true}],
  defaultWarehouse:()=>({id:'MAIN'}),
  inventoryProductKey:item=>item.productId,
  inventoryRefFor:item=>db.collection('inventory').doc(item.productId),
  warehouseStockDocId:(wid,pid)=>wid+'__'+pid,
  inventoryNumbers:data=>inventory.normalizeStock(data),
  inventoryMovementRecord:(type,qty,orderId,productKey,actor,extra)=>({type,qty,orderId,productKey,actor,...extra}),
  invalidateWarehouseStockCache:()=>{},
  salesCodeForName:()=> 'S01',
  loadWarehouseMaster:async()=>{},
  YushinReservation:core
 });
 context.runRoleTransaction=callback=>db.runTransaction(callback);
 vm.runInContext(app.slice(start,end)+'\n'+app.slice(rs,re),context);
 return {context,docs};
}
const order=()=>({
 createdByUid:'U1',ownerUid:'U1',status:'active',customerName:'客戶',warehouseId:'MAIN',orderDate:'2026-10-14',
 items:[{itemId:'A',productId:'P',itemCode:'P',itemName:'產品',qty:3,warehouseId:'MAIN',fulfillmentType:'WAREHOUSE',procurementType:'PURCHASING_PO'}]
});

test('new customer order selects warehouse with stock before order is committed, then reserves without a false shortage',async()=>{
 const f=setup({
  'inventory/P':{productKey:'P',onHand:5,reserved:0},
  'warehouseStocks/MAIN__P':{productKey:'P',warehouseId:'MAIN',onHand:0,reserved:0},
  'warehouseStocks/EXT__P':{productKey:'P',warehouseId:'EXT',onHand:5,reserved:0}
 });
 const created=await f.context.createOrResumeNewOrder(order());
 const saved=f.docs.get('orders/'+created.id);
 assert.equal(saved.items[0].warehouseId,'EXT');
 assert.equal(saved.warehouseId,'EXT');
 const reserved=await f.context.reserveSingleOrderItem(created.id,saved,saved.items[0],0);
 assert.equal(reserved.reservedQty,3);
 assert.equal(reserved.shortageQty,0);
 assert.equal(f.docs.get('inventory/P').reserved,3);
 assert.equal(f.docs.get('warehouseStocks/MAIN__P').reserved,0);
 assert.equal(f.docs.get('warehouseStocks/EXT__P').reserved,3);
 assert.equal(f.docs.get('inventoryReservations/'+created.id+'__A').warehouseId,saved.items[0].warehouseId);
});

test('distributed warehouse stock blocks false purchase classification instead of saving an inconsistent source',async()=>{
 const f=setup({
  'inventory/P':{productKey:'P',onHand:5,reserved:0},
  'warehouseStocks/MAIN__P':{productKey:'P',warehouseId:'MAIN',onHand:2,reserved:0},
  'warehouseStocks/EXT__P':{productKey:'P',warehouseId:'EXT',onHand:3,reserved:0}
 });
 const item=order();item.items[0].qty=5;
 await assert.rejects(f.context.createOrResumeNewOrder(item),/調撥/);
 assert.equal(f.docs.has('orders/O1'),false);
});
