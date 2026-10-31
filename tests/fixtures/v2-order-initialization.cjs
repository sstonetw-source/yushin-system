'use strict';
// Emulator-only setup for V2 multi-location downstream lifecycle tests.
// The V2 backend seeds multi-location stock/demand, then the real browser
// coordinator checks its completed source. This is NOT a proof of the new
// initial whole-order transaction (tested in emulator-order-reservation.cjs).
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createHash}=require('node:crypto');
const {commitSingleItemTwoWarehouse,commitOrderTwoWarehouse}=require('../../functions/single-item-location-service');
const root=path.resolve(__dirname,'../..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
function section(source,start,end){
 const a=source.indexOf(start),b=source.indexOf(end,a);
 if(a<0||b<0)throw Error('Initialization source boundary changed');
 return source.slice(a,b);
}
function fault(message,code='permission-denied'){const error=new Error(message);error.code=code;throw error;}
async function synchronizeV2OrderFixture(db,uid,{orderId,warehouseIds,hooks={}}){
 if(!process.env.FIRESTORE_EMULATOR_HOST||db.projectId!=='demo-yushin')fault('初始化測試僅允許 demo-yushin Emulator','failed-precondition');
 const sourceRef=db.collection('orders').doc(orderId),initial=await sourceRef.get();
 if(!initial.exists)fault('來源訂單不存在','not-found');
 if(initial.data().selfOrderAtCreation===true)fault('此初始化驗收尚不包含初始自行訂貨','failed-precondition');
 const c=vm.createContext({db,currentUser:{uid},currentUserRole:'',currentUserName:uid,console,
  BUSINESS_STATUS:{CANCELLED:'cancelled',VOIDED:'voided'},
  YushinFulfillment:require('../../modules/fulfillment-core'),YushinWorkflow:require('../../modules/workflow-core'),
  YushinReservation:require('../../modules/reservation-core'),YushinProcurementDemand:require('../../modules/procurement-demand-core'),
  brandIdentityForRecord:item=>({brand:item.brand||'',brandId:item.brandId||''}),normalizeHistoryItemCode:value=>value,
  parseMoney:value=>Number(value||0),inventoryProductKey:item=>item.inventoryProductKey||item.productId,
  firestoreReadWithTimeout:promise=>promise,invalidateProcurementDemandQueue(){},defaultWarehouse:()=>({id:warehouseIds[0]})});
 c.window=c;
 const workspace=read('src/features/orders/order-workspace.js');
 vm.runInContext(section(workspace,'function normalizedOrderItems(','function orderLifecycleActionButtons('),c);
 vm.runInContext(section(workspace,'function orderItemWorkCategory(','function orderItemDisplayCategory('),c);
 vm.runInContext(section(workspace,'function orderWorkCategories(','function orderItemWorkAmount('),c);
 vm.runInContext(section(workspace,'function orderInventorySyncIncomplete(','function orderInventorySyncStatusHtml('),c);
 const purchasing=read('src/features/purchasing/purchasing-workspace.js');
 vm.runInContext(section(purchasing,'function procurementDemandForOrderItem(','function remainingProcurementQty('),c);
 vm.runInContext(read('src/services/order-reservation.js'),c);
 vm.runInContext(read('src/services/self-order-supply.js'),c);
 c.loadWarehouseMaster=async()=>{
  const records=await Promise.all(warehouseIds.map(id=>db.collection('warehouses').doc(id).get()));
  c.warehouseMasterCache=records.filter(s=>s.exists).map(s=>({id:s.id,...s.data()}));
  c.warehouseMasterLoadPromise=Promise.resolve(c.warehouseMasterCache);
 };
 c.runRoleTransaction=callback=>db.runTransaction(async tx=>{
  if(c.currentUser?.uid!==uid)fault('登入身份已變更');
  const profile=await tx.get(db.collection('users').doc(uid)),source=await tx.get(sourceRef);
  if(!profile.exists||profile.data().active===false||profile.data().disabled===true)fault('使用者已停用或不存在');
  c.currentUserRole=profile.data().role;
  if(!source.exists)fault('來源訂單不存在','not-found');
  if(!c.canRetryOrderInventorySync({id:orderId,...source.data()}))fault('無權同步這筆訂單');
  let completed=false;
  const adapter={get:ref=>tx.get(ref),set:(...args)=>tx.set(...args),update:(ref,value)=>{
   if(value.inventoryReservationStatus==='completed')completed=true;
   return tx.update(ref,value);
  }};
  const result=await callback(adapter);
  return {result,completed};
 }).then(({result,completed})=>{
  if(completed&&hooks.completionResponseLost){hooks.completionResponseLost=false;throw Error('初始化完成回覆遺失');}
  return result;
 });
 // The V2 multi-location service remains the isolated test setup for
 // cancellation, return and shipment. It is never called from shipped code.
 // Multi-line sources use one V2 transaction before demand projection.
 const sourceItems=c.normalizedOrderItems(initial.data());
 let wholeReservation;
 c.reserveSingleOrderItem=async(id,liveOrder,item)=>{
  const reserve=async()=>{
   if(hooks.beforeReservation)await hooks.beforeReservation({context:c,order:liveOrder});
   const syncAttemptId=liveOrder.inventoryReservationAttemptId;
   const whole=sourceItems.length>1;
   const identity=whole?sourceItems.map(i=>i.itemId).sort():item.itemId;
   const attemptId=(whole?'init-order-v2-':'init-v2-')+createHash('sha256').update(JSON.stringify([id,identity,syncAttemptId])).digest('hex');
   const result=whole
    ?await commitOrderTwoWarehouse(db,uid,{orderId:id,itemIds:sourceItems.map(i=>i.itemId),warehouseIds,attemptId,syncAttemptId})
    :await commitSingleItemTwoWarehouse(db,uid,{orderId:id,itemId:item.itemId,warehouseIds,attemptId,syncAttemptId});
   if(hooks.afterReservation)await hooks.afterReservation({context:c,order:liveOrder,result});
   return result;
  };
  const result=sourceItems.length>1?await (wholeReservation||=reserve()):await reserve();
  if(hooks.beforeDemand)await hooks.beforeDemand({context:c,order:liveOrder,item});
  await c.persistOrderProcurementDemands(id,liveOrder,[item],{actorUid:uid,syncAttemptId:liveOrder.inventoryReservationAttemptId});
  if(hooks.afterDemand)await hooks.afterDemand({context:c,order:liveOrder,item});
  return result;
 };
 // The retired SDK entry no longer exists in production. Retain this adapter
 // only for downstream V2 lifecycle fixtures; the whole-order backend's
 // authoritative reservation/receipt is independently covered by Emulator.
 c.orderReservationBackendEnabled=()=>true;
 c.commitNewOrderReservationPreview=async(id,liveOrder,actorUid)=>{
  if(actorUid!==uid)fault('初始化身分已變更');
  for(const item of sourceItems)await c.reserveSingleOrderItem(id,liveOrder,item);
  const latest=await sourceRef.get();
  if(!latest.exists)fault('初始化後訂單已不存在','not-found');
  const finished={id,...latest.data(),inventoryReservationStatus:'completed'};
  await sourceRef.update({inventoryReservationStatus:'completed',
   inventoryReservationError:'',inventoryReservationUpdatedAt:new Date().toISOString(),
   ...c.orderWorkIndexFields(finished)});
  if(hooks.completionResponseLost){
   hooks.completionResponseLost=false;
   throw Error('初始化完成回覆遺失');
  }
  return true;
 };
 const order={id:orderId,...initial.data()},summary=await c.synchronizeOrderInventory(orderId,order,uid);
 return {order,summary};
}
module.exports={synchronizeV2OrderFixture};
