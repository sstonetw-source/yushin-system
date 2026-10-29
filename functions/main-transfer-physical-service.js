'use strict';
const {createHash}=require('node:crypto');
const {mainTransferRequestProject}=require('./main-transfer-request-service');
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const {planTransferDispatch,planTransferReceipt}=require('./shared/warehouse-logistics');
const {reconcileStockLots,allocateLots}=require('./shared/inventory-core');
function fault(message,code='failed-precondition'){throw Object.assign(Error(message),{code});}
function id(v){if(typeof v!=='string'||!v||v!==v.trim()||v.length>160||v.includes('/'))fault('調撥識別碼不正確','invalid-argument');return v;}
function physicalProject(action,env=process.env){
 // Reuse the project boundary, but require the independent physical-event flag.
 const flag=action==='DISPATCH'?'MAIN_TRANSFER_DISPATCH':action==='RECEIVE'?'MAIN_TRANSFER_RECEIPT':'';
 if(!flag)return '';
 const project=projectIdFromEnvironment(env);
 if(project==='preview-20135'&&env['ENABLE_PREVIEW_'+flag]!=='true')return '';
 if(project==='demo-yushin'&&env['ENABLE_'+flag+'_EMULATOR']!=='true')return '';
 return mainTransferRequestProject({...env,ENABLE_PREVIEW_MAIN_TRANSFER_REQUEST:'true',ENABLE_MAIN_TRANSFER_REQUEST_EMULATOR:'true'});
}
function normalizePhysicalIntent(action,data){
 const keys=action==='DISPATCH'?['id','requestId']:action==='RECEIVE'?['id','operationId']:[];
 if(!keys.length||!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==2||Object.keys(data).some(k=>!keys.includes(k)))fault('調撥動作欄位不正確','invalid-argument');
 const intent={action,id:id(data.id)};
 if(intent.id.length>96)fault('調撥操作識別碼過長','invalid-argument');
 if(action==='DISPATCH')intent.requestId=id(data.requestId);
 else {intent.operationId=id(data.operationId);if(!/^[a-zA-Z0-9_-]{12,96}$/.test(intent.operationId))fault('收貨操作識別碼不正確','invalid-argument');}
 return {...intent,hash:createHash('sha256').update(JSON.stringify(intent)).digest('hex')};
}
function stockId(warehouse,key){return encodeURIComponent(warehouse)+'__'+encodeURIComponent(key);}
function physical(data){return data&&data.active!==false&&!data.systemCustody&&data.warehouseType!=='CUSTODY';}
function quantity(v){if(typeof v!=='number'||!Number.isFinite(v)||v<=0||v>1000000)fault('調撥原始數量不正確');return v;}
function validateTransfer(t,intent){
 if(!t||t.id!==intent.id||t.kind!=='TRANSFER'||t.orderId||t.itemId||t.reservedQty!==0||!t.requestId
  ||!t.dispatchIntentHash||!['IN_TRANSIT','RECEIVED'].includes(t.status))fault('本入口只接受主倉備貨調撥憑證');
 if(t.dispatchIntentHash!==normalizePhysicalIntent('DISPATCH',{id:t.id,requestId:t.requestId}).hash)fault('調撥原寄出意圖不一致');
 const key=id(t.productKey),from=id(t.fromWarehouseId),to=id(t.toWarehouseId);quantity(t.qty);
 if(from===to||from.startsWith('custody-')||to.startsWith('custody-')||t.inventoryId!==encodeURIComponent(key)
  ||t.fromStockId!==stockId(from,key)||t.toStockId!==stockId(to,key))fault('調撥庫存來源不一致');
 if(!Array.isArray(t.allocations)||!t.allocations.length||t.allocations.length>101)fault('調撥批次憑證不正確');
 const seen=new Set();let sum=0;
 for(const [n,a] of t.allocations.entries()){
  id(a.lotId);id(a.costLotId);
  if(a.targetLotId!==t.id+'-'+n||seen.has(a.lotId))fault('調撥批次來源重複或失配');seen.add(a.lotId);sum+=quantity(a.qty);
 }
 if(Math.abs(sum-t.qty)>1e-8)fault('調撥批次總數不一致');
}
async function commitMainTransferPhysical(db,uid,data,action,env=process.env){
 const project=physicalProject(action,env);if(!project||db.projectId!==project)fault('主倉實貨調撥後端未獲授權');
 const intent=normalizePhysicalIntent(action,data);
 return db.runTransaction(async tx=>{
  const ref=(n,k)=>db.collection(n).doc(k),user=await tx.get(ref('users',id(uid)));
  if(!user.exists||user.data().active===false||user.data().disabled===true||!['admin','purchaser','warehouse'].includes(user.data().role))fault('沒有實貨調撥權限','permission-denied');
  const role=user.data().role,actor=user.data().displayName||user.data().name||uid,transferRef=ref('stockTransfers',intent.id),prior=await tx.get(transferRef);
  const dispatchProofRef=ref('reservationOperationReceipts','main-transfer-dispatch-'+intent.id),dispatchProof=await tx.get(dispatchProofRef);
  const receiptProofRef=action==='RECEIVE'?ref('reservationOperationReceipts','main-transfer-receipt-'+intent.operationId):null;
  const receiptProof=receiptProofRef?await tx.get(receiptProofRef):null;
  const assertDispatchProof=t=>{
   const proof=dispatchProof.exists?dispatchProof.data():null;
   if(!proof||proof.kind!=='MAIN_TRANSFER_DISPATCH'||!proof.transfer||proof.intentHash!==t.dispatchIntentHash)fault('找不到可信任的寄出操作憑證');
   for(const [key,value] of Object.entries(proof.transfer))if(key!=='status'&&JSON.stringify(t[key])!==JSON.stringify(value))fault('調撥已偏離原寄出操作憑證');
  };
  const result=status=>({status,action,id:intent.id,operationId:action==='DISPATCH'?intent.id:intent.operationId,actorUid:uid,actorRole:role});
  if(action==='DISPATCH'&&prior.exists){
   const t=prior.data();validateTransfer(t,intent);assertDispatchProof(t);
   if(t.requestId!==intent.requestId||t.dispatchIntentHash!==intent.hash||t.createdByUid!==uid||t.createdByRole!==role)fault('寄出操作識別碼衝突','already-exists');
   return result('already-applied');
  }
  if(action==='RECEIVE'&&!prior.exists)fault('調撥不存在','not-found');
  const t=prior.exists?prior.data():null;
  if(t){
   validateTransfer(t,intent);assertDispatchProof(t);
   if(t.status==='RECEIVED'){
    if(!receiptProof.exists||receiptProof.data().kind!=='MAIN_TRANSFER_RECEIPT'||receiptProof.data().intentHash!==intent.hash
      ||receiptProof.data().transferId!==intent.id||receiptProof.data().actorUid!==uid||receiptProof.data().actorRole!==role
      ||t.receiptOperationId!==intent.operationId||t.receiptIntentHash!==intent.hash||t.receivedByUid!==uid||t.receivedByRole!==role)fault('收貨操作識別碼衝突','already-exists');
    return result('already-applied');
   }
  }
  if(action==='DISPATCH'&&dispatchProof.exists)fault('寄出操作憑證已存在');
  if(receiptProof?.exists)fault('收貨操作憑證已存在');
  const requestRef=ref('stockTransferRequests',id(action==='DISPATCH'?intent.requestId:t.requestId)),request=await tx.get(requestRef);
  if(!request.exists)fault('主倉備貨需求不存在');const r=request.data();
  if(r.id!==requestRef.id||r.status!==(action==='DISPATCH'?'PENDING':'SHIPPED')
   ||(action==='RECEIVE'&&r.transferId!==intent.id))fault('主倉備貨需求已變更');
  const inventoryId=id(r.inventoryId),key=id(r.productKey),from=id(r.fromWarehouseId),to=id(r.toWarehouseId),qty=quantity(r.qty);
  if(inventoryId!==encodeURIComponent(key)||from===to||from.startsWith('custody-')||to.startsWith('custody-')||r.fromStockId!==stockId(from,key))fault('主倉需求來源不一致');
  if(t&&(t.inventoryId!==inventoryId||t.productKey!==key||t.fromWarehouseId!==from||t.toWarehouseId!==to||t.qty!==qty))fault('調撥與主倉需求不一致');
  const invRef=ref('inventory',inventoryId),inv=await tx.get(invRef),sourceWh=await tx.get(ref('warehouses',from)),targetWh=await tx.get(ref('warehouses',to));
  if(!inv.exists||inv.data().productKey!==key||!targetWh.exists||!physical(targetWh.data())||targetWh.data().isDefault!==true
   ||(action==='DISPATCH'&&(!sourceWh.exists||!physical(sourceWh.data()))))fault('公司庫存或調撥倉庫設定不正確');
  const fromRef=ref('warehouseStocks',stockId(from,key)),toRef=ref('warehouseStocks',stockId(to,key));
  const selectedRef=action==='DISPATCH'?fromRef:toRef,selected=await tx.get(selectedRef),stock=selected.exists?selected.data():{};
  if((action==='DISPATCH'&&!selected.exists)||(selected.exists&&(stock.productKey!==key||stock.warehouseId!==(action==='DISPATCH'?from:to))))fault('調撥分倉來源不一致');
  const outRef=ref('inventoryMovements',intent.id+'-out'),out=await tx.get(outRef),inRef=ref('inventoryMovements',intent.id+'-in'),incoming=await tx.get(inRef);
  if(incoming.exists||(action==='DISPATCH'&&out.exists))fault('調撥異動憑證已存在');
  if(action==='RECEIVE'&&(!out.exists||out.data().type!=='warehouse_transfer_out'||out.data().sourceId!==intent.id
    ||out.data().transferId!==intent.id||out.data().productKey!==key||out.data().warehouseId!==from
    ||out.data().fromWarehouseId!==from||out.data().toWarehouseId!==to||out.data().qty!==-qty))fault('找不到有效的原調撥寄出憑證');
  const now=new Date().toISOString(),raw=inv.data();
  const move=(type,amount,warehouse)=>({type,qty:amount,productKey:key,warehouseId:warehouse,fromWarehouseId:from,toWarehouseId:to,
   sourceType:'WAREHOUSE_TRANSFER',sourceId:intent.id,transferId:intent.id,orderId:'',itemId:'',createdAt:now,createdBy:actor,actorUid:uid});
  if(action==='DISPATCH'){
   const plan=planTransferDispatch({aggregateStock:raw,warehouseStock:stock,qty,heldQty:qty});
   // Query is inside the Admin transaction, so inserted/changed lots participate in conflict detection.
   const query=await tx.get(db.collection('inventoryLots').where('productKey','==',key).where('warehouseId','==',from).limit(101));
   if(query.size>100)fault('調撥批次超過本入口100筆上限');
   const lots=query.docs.map(s=>({...s.data(),id:s.id}));
   for(const lot of lots){if(lot.productKey!==key||lot.warehouseId!==from)fault('批次來源不一致');
    const value=lot.remainingQty??lot.qty;if(typeof value!=='number'||!Number.isFinite(value)||value<0)fault('批次數量不正確');}
   const unbatchedRef=ref('inventoryLots',intent.id+'-unbatched-source'),unbatched=await tx.get(unbatchedRef);
   if(unbatched.exists)fault('未分批來源識別碼衝突');
   const reconciled=reconcileStockLots(lots,stock.onHand,unbatchedRef.id),allocation=allocateLots(reconciled.lots,qty);
   const allocations=allocation.allocations.map((a,n)=>{const lot=reconciled.lots.find(l=>l.id===a.lotId);return {lotId:a.lotId,lotNo:a.lotNo,expiryDate:a.expiryDate,qty:a.qty,targetLotId:intent.id+'-'+n,costLotId:lot.costLotId||a.lotId,...(lot.unbatched?{unbatched:true}:{})};});
   const saved={id:intent.id,requestId:intent.requestId,inventoryId,productKey:key,productId:raw.productId||key,
    itemCode:raw.itemCode||'',itemName:raw.itemName||'',brand:raw.brand||'',brandId:raw.brandId||'',fromWarehouseId:from,toWarehouseId:to,
    fromStockId:fromRef.id,toStockId:toRef.id,qty,reservedQty:0,status:'IN_TRANSIT',kind:'TRANSFER',orderId:'',itemId:'',itemIndex:-1,
    ownerUid:'',allocations,createdAt:now,createdBy:actor,createdByUid:uid,createdByRole:role,deliveryPlan:{},dispatchIntentHash:intent.hash};
   validateTransfer(saved,intent);
   tx.create(dispatchProofRef,{kind:'MAIN_TRANSFER_DISPATCH',intentHash:intent.hash,transfer:saved,actorUid:uid,actorRole:role,createdAt:now});
   tx.create(transferRef,saved);tx.update(fromRef,{...plan.source,updatedAt:now});tx.update(invRef,{...plan.aggregate,updatedAt:now});
   for(const a of allocations){if(a.lotId!==reconciled.unbatched?.id){const lot=lots.find(l=>l.id===a.lotId);tx.update(ref('inventoryLots',a.lotId),{remainingQty:(lot.remainingQty??lot.qty)-a.qty,updatedAt:now});}}
   if(reconciled.unbatched){const lot=reconciled.unbatched,issued=allocations.find(a=>a.lotId===lot.id)?.qty||0;
    tx.create(unbatchedRef,{productKey:key,productId:saved.productId,warehouseId:from,lotNo:'',expiryDate:'',receivedQty:lot.receivedQty,
     remainingQty:lot.remainingQty-issued,unbatched:true,sourceType:'MANUAL_STOCK_BALANCE',sourceId:intent.id,receivedAt:now,createdBy:actor});}
   tx.update(requestRef,{status:'SHIPPED',transferId:intent.id,shippedAt:now,shippedByUid:uid});tx.create(outRef,move('warehouse_transfer_out',-qty,from));
  }else{
   const plan=planTransferReceipt({aggregateStock:raw,warehouseStock:stock,qty});
   // All destination identities are read before any write; never overwrite a lot/cost witness.
   for(const a of t.allocations){
    const target=await tx.get(ref('inventoryLots',a.targetLotId)),cost=await tx.get(ref('inventoryLotCosts',a.targetLotId));
    if(target.exists||cost.exists)fault('目的倉批次或成本憑證已存在');
    const source=await tx.get(ref('inventoryLots',a.lotId));
    if(!source.exists||source.data().productKey!==key||source.data().warehouseId!==from
      ||(source.data().costLotId||a.lotId)!==a.costLotId)fault('原寄出批次追溯不一致');
   }
   tx.update(invRef,{...plan.aggregate,updatedAt:now});
   tx.set(toRef,{productKey:key,productId:t.productId,warehouseId:to,itemCode:t.itemCode,itemName:t.itemName,brand:t.brand,brandId:t.brandId,...plan.target,updatedAt:now},{merge:true});
   for(const a of t.allocations){
    tx.create(ref('inventoryLots',a.targetLotId),{productKey:key,productId:t.productId,warehouseId:to,lotNo:a.lotNo||'',expiryDate:a.expiryDate||'',qty:a.qty,remainingQty:a.qty,
     ...(a.unbatched?{unbatched:true}:{}),receivedAt:now,createdAt:now,sourceType:'WAREHOUSE_TRANSFER',sourceId:intent.id,costLotId:a.costLotId,transferId:intent.id,itemCode:t.itemCode,itemName:t.itemName});
    tx.create(ref('inventoryLotCosts',a.targetLotId),{lotId:a.targetLotId,productKey:key,warehouseId:to,sourceType:'WAREHOUSE_TRANSFER',sourceId:intent.id,costSourceLotId:a.costLotId,createdAt:now});
   }
   tx.create(inRef,move('warehouse_transfer_in',qty,to));
   tx.create(receiptProofRef,{kind:'MAIN_TRANSFER_RECEIPT',intentHash:intent.hash,transferId:intent.id,actorUid:uid,actorRole:role,createdAt:now});
   // Auto-allocation remains a separate, resumable transaction; this service only confirms physical receipt.
   tx.update(transferRef,{status:'RECEIVED',receivedAt:now,receivedByUid:uid,receivedByRole:role,receiptOperationId:intent.operationId,receiptIntentHash:intent.hash,
    autoAllocationQty:qty,autoAllocatedQty:0,allocationCompleted:false});
  }
  return result('applied');
 });
}
function createMainTransferPhysicalCallables({onCall,HttpsError,getDatabase,env=process.env}){
 const wrap=action=>onCall({region:'asia-east1'},async request=>{
  if(!physicalProject(action,env))throw new HttpsError('failed-precondition','主倉實貨調撥後端尚未啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  try{return await commitMainTransferPhysical(getDatabase(),request.auth.uid,request.data,action,env);}
  catch(e){if(['invalid-argument','failed-precondition','permission-denied','already-exists','not-found'].includes(e.code))throw new HttpsError(e.code,e.message);
   console.error('Main transfer physical event failed',e);throw new HttpsError('internal','調撥結果無法確認，請保留原操作識別碼');}
 });
 return {dispatchV2MainTransfer:wrap('DISPATCH'),receiveV2MainTransfer:wrap('RECEIVE')};
}
module.exports={physicalProject,normalizePhysicalIntent,commitMainTransferPhysical,createMainTransferPhysicalCallables};
