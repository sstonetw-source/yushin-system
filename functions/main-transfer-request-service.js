'use strict';
const {createHash}=require('node:crypto');
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const {planMainTransferHold}=require('./shared/reservation-core');
function fault(message,code='failed-precondition'){const e=new Error(message);e.code=code;throw e;}
function id(v){if(typeof v!=='string'||!v||v!==v.trim()||v.length>160||v.includes('/'))fault('調撥識別碼不正確','invalid-argument');return v;}
function mainTransferRequestProject(env=process.env){
 const p=projectIdFromEnvironment(env),local=v=>typeof v==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(v);
 if(p==='preview-20135'&&env.ENABLE_PREVIEW_MAIN_TRANSFER_REQUEST==='true'
  &&!env.FUNCTIONS_EMULATOR&&!env.FIRESTORE_EMULATOR_HOST&&!env.FIREBASE_AUTH_EMULATOR_HOST)return p;
 if(p==='demo-yushin'&&env.ENABLE_MAIN_TRANSFER_REQUEST_EMULATOR==='true'&&env.FUNCTIONS_EMULATOR==='true'
  &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST))return p;
 return '';
}
function normalizeMainTransferRequest(action,data){
 const keys=action==='CREATE'?['id','inventoryId','fromWarehouseId','toWarehouseId','qty']:action==='CANCEL'?['id','operationId']:null;
 if(!keys||!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!keys.includes(k)))fault('調撥請求含未授權欄位','invalid-argument');
 const intent={action,id:id(data.id)};
 if(action==='CREATE'){
  if(intent.id.length>128||typeof data.qty!=='number'||!Number.isFinite(data.qty)||data.qty<=0||data.qty>1000000)fault('調回數量不正確','invalid-argument');
  Object.assign(intent,{inventoryId:id(data.inventoryId),fromWarehouseId:id(data.fromWarehouseId),toWarehouseId:id(data.toWarehouseId),qty:data.qty});
  if(intent.fromWarehouseId===intent.toWarehouseId)fault('來源與主倉不可相同','invalid-argument');
 }else{
  intent.operationId=id(data.operationId);
  if(!/^[a-zA-Z0-9_-]{12,96}$/.test(intent.operationId))fault('取消操作識別碼不正確','invalid-argument');
 }
 return {...intent,hash:createHash('sha256').update(JSON.stringify(intent)).digest('hex')};
}
function physical(data){return data&&data.active!==false&&!data.systemCustody&&data.warehouseType!=='CUSTODY';}
async function commitMainTransferRequest(db,uid,data,action,env=process.env){
 const project=mainTransferRequestProject(env);if(!project||db.projectId!==project)fault('主倉調撥資料庫未獲授權');
 const intent=normalizeMainTransferRequest(action,data);
 return db.runTransaction(async tx=>{
  const ref=(n,k)=>db.collection(n).doc(k),user=await tx.get(ref('users',id(uid)));
  if(!user.exists||user.data().active===false||user.data().disabled===true||!['admin','purchaser'].includes(user.data().role))fault('沒有主倉備貨權限','permission-denied');
  const role=user.data().role,requestRef=ref('stockTransferRequests',intent.id),snapshot=await tx.get(requestRef);
  const prior=snapshot.exists?snapshot.data():null;
  const result=status=>({status,action,id:intent.id,operationId:action==='CREATE'?intent.id:intent.operationId,actorUid:uid,actorRole:role});
  if(action==='CREATE'&&prior){
   if(prior.requestIntentHash!==intent.hash||prior.createdByUid!==uid||prior.createdByRole!==role)fault('調回識別碼已對應其他內容或角色','already-exists');
   return result('already-applied');
  }
  if(action==='CANCEL'){
   if(!prior)fault('調回需求不存在','not-found');
   if(prior.status==='CANCELLED'){
    if(prior.cancelIntentHash!==intent.hash||prior.cancelledByUid!==uid||prior.cancelledByRole!==role)fault('取消操作已對應其他內容或角色','already-exists');
    return result('already-applied');
   }
   if(prior.status!=='PENDING')fault('已寄出的調撥不能取消需求');
  }
  const source=action==='CREATE'?intent:prior;
  const inventoryId=id(source.inventoryId),from=id(source.fromWarehouseId),to=id(source.toWarehouseId);
  if(from===to||from.startsWith('custody-')||to.startsWith('custody-'))fault('主倉或來源位置不正確');
  const invRef=ref('inventory',inventoryId),inv=await tx.get(invRef);if(!inv.exists)fault('找不到公司庫存');
  const raw=inv.data(),key=id(raw.productKey||raw.productId),stockId=encodeURIComponent(from)+'__'+encodeURIComponent(key);
  if(inventoryId!==encodeURIComponent(key))fault('公司庫存識別與產品不一致');
  const stockRef=ref('warehouseStocks',stockId),stock=await tx.get(stockRef);
  if(!stock.exists||stock.data().productKey!==key||stock.data().warehouseId!==from
   ||(action==='CANCEL'&&(prior.productKey!==key||prior.fromStockId!==stockId)))fault('分倉或需求庫存來源不一致');
  if(action==='CREATE'){
   const a=await tx.get(ref('warehouses',from)),b=await tx.get(ref('warehouses',to));
   if(!a.exists||!b.exists||!physical(a.data())||!physical(b.data())||b.data().isDefault!==true)fault('來源分倉或主倉設定不正確');
  }
  // Release remains possible after a warehouse is disabled, as in the original service.
  if(typeof source.qty!=='number'||!Number.isFinite(source.qty)||source.qty<=0||source.qty>1000000)fault('原調回需求數量不正確');
  for(const balance of [raw,stock.data()]){
   for(const field of ['onHand','reserved','transferReserved','transferFreeInTransit']){
    const value=balance[field]??0;if(typeof value!=='number'||!Number.isFinite(value)||value<0)fault('公司／分倉庫存數量不正確');
   }
   if((balance.reserved??0)+(balance.transferFreeInTransit??0)>(balance.onHand??0))fault('預留與途中貨超過實貨');
  }
  for(const field of ['onHand','reserved','transferReserved'])
   if((raw[field]??0)<(stock.data()[field]??0))fault('公司彙總不足以支持來源分倉庫存');
  let plan;try{plan=planMainTransferHold({qty:source.qty,release:action==='CANCEL',aggregateStock:raw,warehouseStock:stock.data()});}
  catch(e){fault(e.message);}
  const now=new Date().toISOString();
  if(action==='CREATE')tx.create(requestRef,{id:intent.id,inventoryId,productKey:key,productId:raw.productId||key,
   itemCode:raw.itemCode||'',itemName:raw.itemName||'',brand:raw.brand||'',fromWarehouseId:from,toWarehouseId:to,
   fromStockId:stockId,qty:intent.qty,status:'PENDING',createdByUid:uid,createdByRole:role,createdAt:now,requestIntentHash:intent.hash});
  else tx.update(requestRef,{status:'CANCELLED',cancelledAt:now,cancelledByUid:uid,cancelledByRole:role,
   cancelOperationId:intent.operationId,cancelIntentHash:intent.hash});
  tx.update(stockRef,{...plan.warehouse,updatedAt:now});tx.update(invRef,{...plan.aggregate,updatedAt:now});
  return result('applied');
 });
}
function createMainTransferRequestCallables({onCall,HttpsError,getDatabase,env=process.env}){
 const wrap=action=>onCall({region:'asia-east1'},async request=>{
  if(!mainTransferRequestProject(env))throw new HttpsError('failed-precondition','主倉調撥需求後端尚未啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  try{return await commitMainTransferRequest(getDatabase(),request.auth.uid,request.data,action,env);}
  catch(e){if(['invalid-argument','failed-precondition','permission-denied','not-found','already-exists'].includes(e.code))throw new HttpsError(e.code,e.message);
   console.error('Main transfer request failed',e);throw new HttpsError('internal','調撥需求結果無法確認，請保留原操作識別碼');}
 });
 return {createV2MainTransferRequest:wrap('CREATE'),cancelV2MainTransferRequest:wrap('CANCEL')};
}
module.exports={mainTransferRequestProject,normalizeMainTransferRequest,commitMainTransferRequest,createMainTransferRequestCallables};
