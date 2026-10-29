function mainTransferAllocationKey(id){return 'main-transfer-allocation:'+encodeURIComponent(currentUser?.uid||'')+':'+encodeURIComponent(id);}
function pendingMainTransferAllocations(){
 const prefix=mainTransferAllocationKey(''),rows=[];
 for(let n=0;n<sessionStorage.length;n++){
  const key=sessionStorage.key(n);if(!key?.startsWith(prefix))continue;
  try{const id=decodeURIComponent(key.slice(prefix.length)),p=JSON.parse(sessionStorage.getItem(key));
   if(!id||id.includes('/')||id.length>96||id!==id.trim()||p.uid!==currentUser?.uid||p.role!==currentUserRole
    ||p.project!=='demo-yushin'||p.transferId!==id||Object.keys(p).sort().join(',')!=='project,role,transferId,uid')throw Error('invalid');
   rows.push({id});
  }catch(_){rows.push({error:'分配原操作暫存無法核對，請保留暫存並使用原帳號與角色。'});}
 }
 return rows;
}
const mainTransferAllocationInFlight=new Map();
function resumeMainTransferAllocationBackend(id){
 const key=JSON.stringify([currentUser?.uid,currentUserRole,id]);
 if(mainTransferAllocationInFlight.has(key))return mainTransferAllocationInFlight.get(key);
 const promise=submitMainTransferAllocationBackend(id).finally(()=>mainTransferAllocationInFlight.delete(key));
 mainTransferAllocationInFlight.set(key,promise);return promise;
}
async function submitMainTransferAllocationBackend(id){
 const actorUid=currentUser?.uid,actorRole=currentUserRole;
 if(typeof ensureReservationFunctionsCompat==='function')await ensureReservationFunctionsCompat();
 if(currentUser?.uid!==actorUid||currentUserRole!==actorRole)throw Error('載入後端期間登入身分已變更，尚未提交。');
 // The shared coordinator has no Preview authorization yet. Never fall back.
 if(globalThis.YUSHIN_MAIN_TRANSFER_ALLOCATION_EMULATOR!==true)throw Error('此環境尚未開放分配續傳；實貨已入庫，請保留原調撥紀錄。');
 const {uid,role,project,functions,check}=mainTransferBackendContext({emulatorFlag:'YUSHIN_MAIN_TRANSFER_ALLOCATION_EMULATOR',previewFlag:'YUSHIN_PREVIEW_MAIN_TRANSFER_ALLOCATION',roles:['admin','purchaser','warehouse'],authorized:()=>canReceiveInventoryCapability()&&canAccessPage('inventory')});
 if(typeof id!=='string'||!id||id!==id.trim()||id.includes('/')||id.length>96)throw Error('原調撥識別碼不正確。');
 if(typeof pendingMainTransferPhysical==='function'&&pendingMainTransferPhysical('RECEIVE',id))throw Error('原入庫結果尚未確認，請先核對原收貨操作。');
 const key=mainTransferAllocationKey(id),saved={uid,role,project,transferId:id},raw=JSON.stringify(saved),prior=sessionStorage.getItem(key);
 if(prior!==null&&prior!==raw)throw Error('分配原操作暫存已變更，請保留核對。');
 sessionStorage.setItem(key,raw);if(sessionStorage.getItem(key)!==raw)throw Error('無法保存分配原來源，尚未提交。');
 check();functions.useEmulator('127.0.0.1',5001);
 const response=await functions.httpsCallable('resumeV2MainTransferAllocation')({transferId:id});check();
 const result=response?.data;
 if(result?.transferId!==id||result.sourceMovementId!==id+'-in'||!['active','completed','retry'].includes(result.status)
  ||result.recoveryPending!==(result.status!=='completed')||!Number.isSafeInteger(result.maxQty)||result.maxQty<1||result.maxQty>1000
  ||!Number.isSafeInteger(result.allocatedQty)||result.allocatedQty<0||result.allocatedQty>result.maxQty
  ||!Array.isArray(result.affectedOrderIds)||result.affectedOrderIds.some(value=>typeof value!=='string'||!value))
  throw Error('分配回覆無法核對，請使用原調撥編號確認結果。');
 if(sessionStorage.getItem(key)!==raw)throw Error('分配暫存已變更，請保留原操作核對。');
 if(!result.recoveryPending)sessionStorage.removeItem(key);
 return result;
}
