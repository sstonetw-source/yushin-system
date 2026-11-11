'use strict';
const {createHash}=require('node:crypto');
const Inventory=require('./shared/inventory-core');
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const {allowProductionTransaction}=require('./production-transaction-gate');

function fail(message,code='failed-precondition'){
 const error=new Error(message);error.code=code;throw error;
}
const ident=(value,label)=>{
 if(typeof value!=='string'||!value||value!==value.trim()||value.includes('/')||value.length>160)
  fail(label+'識別碼不正確','invalid-argument');
 return value;
};
const quantity=(value,label,{positive=false}={})=>{
 if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e9||(positive?value<=0:value<0))
  fail(label+'數量不正確','invalid-argument');
 return value;
};
const numeric=(value,label)=>{
 const result=value===undefined?0:value;
 if(typeof result!=='number'||!Number.isFinite(result)||result<0||result>1e9)
  fail(label+'原庫存數量不正確');
 return result;
};
const equal=(a,b)=>Math.abs(a-b)<1e-7;
const ref=(db,collection,id)=>db.collection(collection).doc(id);

function manualStockProject(kind,env=process.env){
 const project=projectIdFromEnvironment(env);
 const ids=[env.GCLOUD_PROJECT,env.GCP_PROJECT,env.GOOGLE_CLOUD_PROJECT].filter(Boolean);
 if(ids.some(value=>value!==project))return '';
 const local=value=>typeof value==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(value);
 if(project==='yu-shing-company'&&allowProductionTransaction(kind,env))return project;
 if(project==='preview-20135'&&env['ENABLE_PREVIEW_'+kind]==='true'
  &&!env.FUNCTIONS_EMULATOR&&!env.FIRESTORE_EMULATOR_HOST&&!env.FIREBASE_AUTH_EMULATOR_HOST)return project;
 if(project==='demo-yushin'&&env['ENABLE_'+kind+'_EMULATOR']==='true'&&env.FUNCTIONS_EMULATOR==='true'
  &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST))return project;
 return '';
}

function normalizeManualStock(data,kind){
 const manual=kind==='MANUAL_INVENTORY',count=kind==='INVENTORY_COUNT';
 const keys=manual?['operationId','productKey','warehouseId','type','qty','lotNo','expiryDate','unitCost']:
  count?['operationId','productKey','warehouseId','target','note']:[];
 if(!keys.length||!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!keys.includes(k)))
  fail('庫存操作包含未授權欄位','invalid-argument');
 const intent={kind,operationId:ident(data.operationId,'操作'),productKey:ident(data.productKey,'產品'),warehouseId:ident(data.warehouseId,'倉庫')};
 if(!/^[a-zA-Z0-9_-]{12,96}$/.test(intent.operationId))fail('操作 ID 格式不正確','invalid-argument');
 if(manual){
  if(!['initial','adjustment','scrap'].includes(data.type))fail('庫存異動類型不正確','invalid-argument');
  if(typeof data.qty!=='number'||!Number.isFinite(data.qty)||data.qty===0||Math.abs(data.qty)>1e9||(data.type==='initial'&&data.qty<0))
   fail('庫存異動數量不正確','invalid-argument');
  const lotNo=data.lotNo??'',expiryDate=data.expiryDate??'';
  if(typeof lotNo!=='string'||lotNo.length>128||typeof expiryDate!=='string'||expiryDate.length>10)
   fail('批號或效期不正確','invalid-argument');
  if(expiryDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)||!Number.isFinite(Date.parse(expiryDate))
   ||new Date(expiryDate).toISOString().slice(0,10)!==expiryDate))fail('效期不正確','invalid-argument');
  Object.assign(intent,{type:data.type,qty:data.qty,delta:data.type==='scrap'?-Math.abs(data.qty):data.qty,
   lotNo:lotNo.trim(),expiryDate});
  if(data.unitCost!==undefined){
   if(data.type!=='initial'||typeof data.unitCost!=='number'||!Number.isFinite(data.unitCost)||data.unitCost<0||data.unitCost>1e12)
    fail('期初成本格式不正確','invalid-argument');
   intent.unitCost=data.unitCost;
  }
 }else{
  intent.target=quantity(data.target,'盤點後');
  if(typeof data.note!=='string'||!data.note.trim()||data.note.length>500)
   fail('請填寫有效的盤點原因','invalid-argument');
  intent.note=data.note.trim();
 }
 intent.hash=createHash('sha256').update(JSON.stringify(intent)).digest('hex');
 return intent;
}

function stock(data,label){
 const result={};for(const field of ['onHand','reserved','incoming','transferReserved','transferInTransit','transferFreeInTransit'])
  result[field]=numeric(data?.[field],label+field);
 if(result.transferReserved>result.reserved||result.reserved+result.transferFreeInTransit>result.onHand+1e-8
  ||result.transferFreeInTransit>result.transferInTransit)
  fail(label+'預留或途中量超過實際庫存');
 return result;
}
function masterMetadata(product,key,previous={}){
 const brand=String(product.brandName||product.brand||previous.brand||'');
 return {productKey:key,productId:key,
  itemCode:String(product.manufacturerPartNo||product.model||previous.itemCode||''),
  itemName:String(product.productName||product.nameCn||product.nameEn||previous.itemName||''),
  brand,brandId:String(product.brandId||previous.brandId||'')};
}
function searchTokens(record){
 const raw=[record.itemCode,record.itemName,record.brand,record.productKey,record.productId,
  ...(record.lots||[]).flatMap(x=>[x.lotNo,x.expiryDate])];const tokens=new Set();
 for(const value of raw){
  const normalized=String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/[\s\-_.\/\\,，。:：;；()（）\[\]{}]+/g,'');
  if(!normalized)continue;
  tokens.add(normalized);
  for(let size=1;size<=Math.min(6,normalized.length);size++)for(let i=0;i+size<=normalized.length;i++){
   tokens.add(normalized.slice(i,i+size));if(tokens.size>=300)return [...tokens];
  }
 }
 return [...tokens];
}
function lotQuantity(lot,key){
 if(lot.productKey!==key||typeof lot.warehouseId!=='string'||!lot.warehouseId||lot.warehouseId.includes('/'))
  fail('批次產品或倉庫識別不一致');
 if(lot.remainingQty===undefined&&lot.qty===undefined)
  fail('批次缺少可核對的剩餘數量');
 return numeric(lot.remainingQty??lot.qty,'批次');
}

async function commitManualStock(db,uid,data,kind,env=process.env){
 const project=manualStockProject(kind,env);
 if(!project||db.projectId!==project||(db.databaseId&&db.databaseId!=='(default)'))fail('庫存後端尚未在此資料庫授權啟用');
 const intent=normalizeManualStock(data,kind),{operationId,productKey:key,warehouseId}=intent;
 return db.runTransaction(async tx=>{
  const profile=await tx.get(ref(db,'users',ident(uid,'登入')));
  if(!profile.exists||profile.data().active===false||profile.data().disabled===true||!['admin','purchaser','warehouse'].includes(profile.data().role))
   fail('沒有人工庫存或盤點權限','permission-denied');
  const actorRole=profile.data().role,actorName=String(profile.data().displayName||profile.data().name||profile.data().email||uid);
  if(kind==='MANUAL_INVENTORY'&&intent.type==='initial'){
   if(['admin','purchaser'].includes(actorRole)&&intent.unitCost===undefined)fail('期初庫存必須填寫實際成本','invalid-argument');
   if(actorRole==='warehouse'&&intent.unitCost!==undefined)fail('倉庫人員不可提交成本','permission-denied');
  }
  const movementRef=ref(db,'inventoryMovements',operationId),prior=await tx.get(movementRef);
  const result=(status,delta)=>({status,operationId,productKey:key,warehouseId,delta,actorUid:uid,actorRole});
  if(prior.exists){
   const saved=prior.data();
   if(saved.intentHash!==intent.hash||saved.actorUid!==uid||saved.actorRole!==actorRole||saved.sourceId!==operationId
    ||saved.operation!==(kind==='MANUAL_INVENTORY'?'manual-adjustment':'quantity-editor'))
    fail('操作 ID 已對應不同內容或帳號','already-exists');
   if(intent.type==='initial'){
    const original=await tx.get(ref(db,'inventoryLotCosts',operationId+'-added'));
    if(!original.exists||original.data().productKey!==key||original.data().warehouseId!==warehouseId
     ||(['admin','purchaser'].includes(actorRole)?original.data().unitCost!==intent.unitCost:original.data().costPending!==true))
     fail('原期初庫存成本與憑證不一致');
   }
   return result('already-applied',saved.qty);
  }
  const productSnap=await tx.get(ref(db,'products',key)),warehouseSnap=await tx.get(ref(db,'warehouses',warehouseId));
  if(!productSnap.exists||productSnap.data().active===false||productSnap.data().status==='INACTIVE')fail('產品不存在或已停用','not-found');
  if(!warehouseSnap.exists||warehouseSnap.data().active===false||warehouseSnap.data().systemCustody
   ||warehouseSnap.data().warehouseType==='CUSTODY'||warehouseId.startsWith('custody-'))fail('實體倉庫不存在或不可操作','not-found');
  const product=productSnap.data();
  if((product.productId&&product.productId!==key)||['service','services','服務'].includes(String(product.productType||'').toLowerCase()))
   fail('產品主檔識別或類型不正確');
  if(kind==='MANUAL_INVENTORY'&&((product.lotTracked&&!intent.lotNo)||(product.expiryTracked&&!intent.expiryDate)))
   fail('缺少產品要求的批號或效期','invalid-argument');
  const invRef=ref(db,'inventory',encodeURIComponent(key)),whRef=ref(db,'warehouseStocks',encodeURIComponent(warehouseId)+'__'+encodeURIComponent(key));
  const invSnap=await tx.get(invRef),whSnap=await tx.get(whRef),old=invSnap.exists?invSnap.data():{},oldWh=whSnap.exists?whSnap.data():{};
  if((old.productKey&&old.productKey!==key)||(old.productId&&old.productId!==key)
   ||(oldWh.productKey&&oldWh.productKey!==key)||(oldWh.warehouseId&&oldWh.warehouseId!==warehouseId))fail('原庫存身分不一致');
  if(kind==='INVENTORY_COUNT'&&!invSnap.exists)fail('尚無公司庫存可供盤點','not-found');
  const company=stock(old,'公司'),wh=stock(oldWh,'分倉');
  // Query reads belong to this same Admin SDK transaction; never perform an
  // out-of-transaction query and then mutate the resulting lot documents.
  const stocks=await tx.get(db.collection('warehouseStocks').where('productKey','==',key).limit(201));
  if(stocks.size>200)fail('分倉紀錄超出安全處理上限');
  const totals={onHand:0,reserved:0,incoming:0,transferReserved:0};let foundTarget=false;
  for(const doc of stocks.docs){
   const value=doc.data(),parts=stock(value,'分倉');
   if(value.productKey!==key||typeof value.warehouseId!=='string'||!value.warehouseId
    ||doc.id!==encodeURIComponent(value.warehouseId)+'__'+encodeURIComponent(key))fail('分倉識別不正確');
   if(value.warehouseId===warehouseId)foundTarget=true;
   for(const field of Object.keys(totals))totals[field]+=parts[field];
  }
  // Dispatch removes physical stock from the sending warehouse while the
  // company still owns it in transit. Reserved in-transit stock is the
  // complement of the free in-transit quantity; neither is available stock.
  const inTransitReserved=company.transferInTransit-company.transferFreeInTransit;
  if(foundTarget!==whSnap.exists
   ||!equal(totals.onHand+company.transferInTransit,company.onHand)
   ||!equal(totals.reserved+inTransitReserved,company.reserved)
   ||!equal(totals.incoming,company.incoming)
   ||!equal(totals.transferReserved,company.transferReserved))
   fail('公司與分倉帳面庫存不一致，請先核對期初資料');
  let delta=kind==='MANUAL_INVENTORY'?intent.delta:intent.target-wh.onHand;
  if(!Number.isFinite(delta)||Math.abs(delta)>1e9||company.onHand+delta<company.reserved+company.transferFreeInTransit-1e-8
   ||wh.onHand+delta<wh.reserved+wh.transferFreeInTransit-1e-8||company.onHand+delta>1e9)
   fail('異動後數量不足以支撐預留或途中量');
  const now=new Date().toISOString(),metadata=masterMetadata(product,key,old);
  const audit={...metadata,warehouseId,type:kind==='MANUAL_INVENTORY'?intent.type:'adjustment',qty:delta,
   operation:kind==='MANUAL_INVENTORY'?'manual-adjustment':'quantity-editor',sourceType:'manual',sourceId:operationId,
   actorUid:uid,actorRole,createdAt:now,createdBy:actorName,intentHash:intent.hash};
  if(kind==='INVENTORY_COUNT')Object.assign(audit,{countInventoryId:encodeURIComponent(key),countTarget:intent.target,note:intent.note});
  else Object.assign(audit,{lotNo:intent.lotNo,expiryDate:intent.expiryDate,
   adjustmentIntent:{type:intent.type,productKey:key,warehouseId,delta,lotNo:intent.lotNo,expiryDate:intent.expiryDate}});
  const lots=await tx.get(db.collection('inventoryLots').where('productKey','==',key).limit(201));
  if(lots.size>200)fail('批次紀錄超出安全處理上限');
  const allLots=lots.docs.map(doc=>({...doc.data(),id:doc.id}));
  for(const lot of allLots)lotQuantity(lot,key);
  // A zero-delta count is still an attestation of the stock ledger. Do not
  // issue a successful count receipt while existing lot records are malformed.
  if(delta===0){tx.create(movementRef,{...audit,lotAllocations:[],lotIds:[]});return result('applied',0);}
  const currentLots=allLots.filter(lot=>lot.warehouseId===warehouseId),balanceId=operationId+'-balance',addedId=operationId+'-added';
  if(intent.type==='initial'){
   // Opening rows may span multiple lots, but may not resume after any
   // operational movement. A new operation ID must not initialize the same
   // product/warehouse/lot twice. Read inside the stock transaction so a
   // concurrent receipt also conflicts on the authoritative stock documents.
   const movements=await tx.get(db.collection('inventoryMovements').where('productKey','==',key).limit(201));
   if(movements.size>200)fail('庫存異動紀錄超出期初核對上限，請停止初始化並核對');
   for(const doc of movements.docs){
    const movement=doc.data();
    if(movement.operation!=='manual-adjustment'||movement.type!=='initial'||movement.sourceType!=='manual'
     ||!movement.adjustmentIntent)fail('已有正式庫存異動，禁止再建立期初庫存');
    if(!movement.warehouseId)fail('舊期初憑證缺少倉庫識別，請先核對');
    if(movement.warehouseId===warehouseId&&movement.adjustmentIntent.lotNo===intent.lotNo
     &&movement.adjustmentIntent.expiryDate===intent.expiryDate)
     fail('此產品倉庫及批次已建立期初庫存，禁止重複初始化','already-exists');
   }
   if(currentLots.some(lot=>lot.sourceType!=='INITIAL_STOCK')
    ||!equal(currentLots.reduce((sum,lot)=>sum+lotQuantity(lot,key),0),wh.onHand))
    fail('倉庫已有非期初批次或未追溯數量，禁止再建立期初庫存');
  }
  const balanceRef=ref(db,'inventoryLots',balanceId),addedRef=ref(db,'inventoryLots',addedId),costRef=ref(db,'inventoryLotCosts',addedId);
  const existingBalance=await tx.get(balanceRef),existingAdded=await tx.get(addedRef),existingCost=await tx.get(costRef);
  if(existingBalance.exists||existingAdded.exists||existingCost.exists)fail('批次或成本識別碼已被使用','already-exists');
  let plan;
  try{plan=kind==='MANUAL_INVENTORY'?Inventory.manualAdjustmentLots(currentLots,wh.onHand,delta,wh.reserved,
   {lotNo:intent.lotNo,expiryDate:intent.expiryDate,balanceId,addedId}):
   Inventory.quantityAdjustmentLots(currentLots,wh.onHand,intent.target,wh.reserved,balanceId,addedId);}
  catch(error){fail(error.message);}
  const nextLots=[...allLots.filter(lot=>lot.warehouseId!==warehouseId),...plan.lots.map(lot=>({...lot,warehouseId}))]
   .map(lot=>({warehouseId:lot.warehouseId,lotNo:lot.lotNo||'',expiryDate:lot.expiryDate||'',qty:numeric(lot.remainingQty??lot.qty,'批次')}));
  const next={...old,...metadata,onHand:company.onHand+delta,reserved:company.reserved,incoming:company.incoming,lots:nextLots,updatedAt:now};
  next.searchTokens=searchTokens(next);
  for(const lot of plan.lots){
   const original=currentLots.find(row=>row.id===lot.id),lotRef=ref(db,'inventoryLots',lot.id);
   if(original){if(!equal(lotQuantity(original,key),lot.remainingQty))tx.update(lotRef,{remainingQty:lot.remainingQty,updatedAt:now});}
   else tx.create(lotRef,{productKey:key,productId:key,warehouseId,lotNo:lot.lotNo||'',expiryDate:lot.expiryDate||'',
    receivedQty:lot.receivedQty,remainingQty:lot.remainingQty,unbatched:lot.unbatched===true,
    sourceType:lot.id===balanceId?'MANUAL_STOCK_BALANCE':kind==='INVENTORY_COUNT'?'MANUAL_ADJUSTMENT':
     intent.type==='initial'?'INITIAL_STOCK':'MANUAL_ADJUSTMENT',sourceId:operationId,receivedAt:now,createdBy:actorName});
  }
  if(intent.type==='initial')tx.create(costRef,{lotId:addedId,productKey:key,productId:key,warehouseId,
   ...(['admin','purchaser'].includes(actorRole)?{unitCost:intent.unitCost}:{costPending:true}),
   sourceType:'INITIAL_STOCK',sourceId:operationId,createdAt:now,createdBy:actorName});
  tx.set(invRef,next,{merge:true});
  tx.set(whRef,{...metadata,warehouseId,onHand:wh.onHand+delta,reserved:wh.reserved,incoming:wh.incoming,updatedAt:now},{merge:true});
  tx.create(movementRef,{...audit,lotAllocations:plan.allocations,
   lotId:delta>0?addedId:'',lotIds:plan.lots.filter(lot=>!currentLots.some(oldLot=>oldLot.id===lot.id)).map(lot=>lot.id)});
  return result('applied',delta);
 });
}

function createManualStockCallables({onCall,HttpsError,getDatabase,env=process.env}){
 const wrap=kind=>onCall({region:'asia-east1'},async request=>{
  if(!manualStockProject(kind,env))throw new HttpsError('failed-precondition','庫存後端尚未啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  try{return await commitManualStock(getDatabase(),request.auth.uid,request.data,kind,env);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','already-exists','not-found'].includes(error.code))
    throw new HttpsError(error.code,error.message);
   console.error('Manual stock transaction failed',error);
   throw new HttpsError('internal','庫存結果未確認，請使用原操作 ID 重試核對');
  }
 });
 return {commitV2ManualInventory:wrap('MANUAL_INVENTORY'),commitV2InventoryCount:wrap('INVENTORY_COUNT')};
}
module.exports={manualStockProject,normalizeManualStock,commitManualStock,createManualStockCallables};
