// Record the source and numerical changes of commercial stock transactions.
// Firestore Rules validate these witnesses against the same atomic order/reservation writes.
(function(root){
  function dataAt(snapshot){return snapshot?.exists ? snapshot.data() : {};}
  function number(value){return Number(value || 0);}
  function reservationDeltas(before,after){
    const core=typeof module==='object'&&module.exports?require('./reservation-core.js'):root.YushinReservation;
    if(!core?.reservationStockDeltas)throw Error('預留計算模組尚未載入，請重新整理後重試。');
    return core.reservationStockDeltas(before,after);
  }
  // Every live fulfillment writer still uses quantity + warehouseId. Keep the
  // proposed location ledger out of these paths until ALL consumers and Rules
  // understand it; even an empty/unknown marker must not silently fall back.
  const pendingLocationFields=['locationSchemaVersion','locations','allocations','warehouseAllocations'];
  function assertReservationLocationCompatibility(ref,data){
    if(!ref.path.startsWith('inventoryReservations/'))return;
    if(!Object.keys(data||{}).some(key=>pendingLocationFields.includes(key.split('.')[0])))return;
    const source=String(data.orderNo||data.orderId||ref.id||'').slice(0,80);
    const item=String(data.itemCode||data.itemId||'').slice(0,80);
    const error=new Error(`預留「${source}${item?'／'+item:''}」含尚未啟用的位置資料，已停止作業。請保留原資料並由管理員核對，勿直接改庫存或重複建單。`);
    error.code='unsupported-reservation-location';
    throw error;
  }
  async function run(db, callback, actorUid, enabled, role, sessionGuard=null){
    let released=[];
    const result=await db.runTransaction(async native=>{
      sessionGuard?.();
      released=[];
      const reads=new Map(),writes=[];
      const sourceRef=ref=>ref.path.startsWith('receivingSupplyOrders/')?db.collection('supplyOrders').doc(ref.id):ref;
      const proxy={
        async get(ref){ref=sourceRef(ref);const readRef=['warehouse','sales','engineer'].includes(role)&&ref.path.startsWith('supplyOrders/')?db.collection('receivingSupplyOrders').doc(ref.id):ref;const snapshot=await native.get(readRef);const data=dataAt(snapshot);assertReservationLocationCompatibility(ref,data);reads.set(ref.path,{ref,snapshot,data});return snapshot;},
        set(ref,data,options){ref=sourceRef(ref);assertReservationLocationCompatibility(ref,data);writes.push({method:'set',ref,data,options});return proxy;},
        update(ref,data){ref=sourceRef(ref);assertReservationLocationCompatibility(ref,data);writes.push({method:'update',ref,data});return proxy;},
        delete(ref){ref=sourceRef(ref);writes.push({method:'delete',ref});return proxy;}
      };
      const result=await callback(proxy);
      {
        for(const write of writes){
          if(!write.ref.path.startsWith('inventoryReservations/')||write.method==='delete')continue;
          assertReservationLocationCompatibility(write.ref,write.data);
          // A blind replacement must not erase an unsupported ledger and then
          // publish a legacy-looking total. Reuse the read when already held.
          if(!reads.has(write.ref.path))await proxy.get(write.ref);
          const reservation={...reads.get(write.ref.path)?.data,...write.data};
          const orderRef=db.collection('orders').doc(reservation.orderId);
          let orderData=reads.get(orderRef.path)?.data;
          if(!orderData){const snapshot=await proxy.get(orderRef);orderData=dataAt(snapshot);}
          const orderWrites=writes.filter(row=>row.ref.path===orderRef.path&&row.method!=='delete');
          const afterOrder=orderWrites.reduce((data,row)=>({...data,...row.data}),orderData);
          const index=(afterOrder.items||[]).findIndex((item,i)=>String(item.itemId||`item-${i+1}`)===reservation.itemId);
          if(index<0)throw new Error('庫存預留缺少對應的來源訂單品項。');
          write.data={...write.data,orderItemIndex:index,ownerUid:afterOrder.ownerUid||'',salesCode:afterOrder.salesCode||''};
        }
      }
      // Operational reservation changes prove both the company and warehouse
      // reserved totals in the same transaction. Reuse existing stock documents.
      if(role==='purchaser'||role==='warehouse'){
        const rows=writes.filter(w=>w.ref.path.startsWith('inventoryReservations/')&&w.method!=='delete');
        for(const w of rows)if(!reads.has(w.ref.path))await proxy.get(w.ref);
        for(const w of rows){
          const before=reads.get(w.ref.path)?.data||{},after={...before,...w.data};
          const delta=reservationDeltas(before,after);
          if(!delta.companyReservedDelta&&!delta.warehouseDeltas.length)continue;
          const siblings=rows.filter(r=>({...reads.get(r.ref.path)?.data,...r.data}).productKey===after.productKey);
          const held=siblings.filter(r=>{const old=reads.get(r.ref.path)?.data||{},next={...old,...r.data};return number(next.quantity)||number(old.quantity);});
          const crossWarehouse=new Set(held.map(r=>({...reads.get(r.ref.path)?.data,...r.data}).warehouseId)).size>1;
          // A grouped reserve/release is not a warehouse transfer. Keep transfer
          // responsibility in its existing dedicated departure/arrival workflow.
          if(crossWarehouse&&held.some(r=>{const old=reads.get(r.ref.path)?.data||{},next={...old,...r.data};return number(old.quantity)>0&&old.warehouseId!==next.warehouseId;}))
            throw Error('跨倉合併預留不能同時搬動既有位置，請使用原調撥流程。');
          const representative=held.find(r=>({...reads.get(r.ref.path)?.data,...r.data}).warehouseId===after.warehouseId);
          if(representative){siblings.splice(siblings.indexOf(representative),1);siblings.unshift(representative);}
          if(siblings.length>5)throw Error('同一產品一次最多處理 5 筆庫存預留，請分批操作。');
          const stockRef=(collection,warehouseId)=>{
            const match=writes.find(r=>r.ref.path.startsWith(collection+'/')&&
              (r.data.productKey||reads.get(r.ref.path)?.data.productKey)===after.productKey&&
              (collection==='inventory'||(r.data.warehouseId||reads.get(r.ref.path)?.data.warehouseId)===warehouseId));
            const read=[...reads.values()].find(r=>r.ref.path.startsWith(collection+'/')&&r.data.productKey===after.productKey&&
              (collection==='inventory'||r.data.warehouseId===warehouseId));
            return match?.ref||read?.ref||db.collection(collection).doc(collection==='inventory'?encodeURIComponent(after.productKey):encodeURIComponent(warehouseId)+'__'+encodeURIComponent(after.productKey));
          };
          const inv=stockRef('inventory',''),wh=stockRef('warehouseStocks',after.warehouseId||''),oldWh=stockRef('warehouseStocks',before.warehouseId||after.warehouseId||'');
          for(const ref of [inv,wh,oldWh])if(!reads.has(ref.path))await proxy.get(ref);
          const movement=writes.find(r=>r.ref.path.startsWith('inventoryMovements/')&&r.data.productKey===after.productKey&&
            (crossWarehouse?r.data.warehouseId===after.warehouseId:
              (!r.data.warehouseId||r.data.warehouseId===after.warehouseId||r.data.warehouseId===before.warehouseId)));
          if(!movement)throw Error('庫存預留異動缺少同筆交易的庫存紀錄。');
          const evidence={inventoryId:inv.id,warehouseStockId:wh.id,previousWarehouseStockId:oldWh.id,
            movementId:movement.ref.id,reservationIds:siblings.map(r=>r.ref.id),...(crossWarehouse?{crossWarehouse:true}:{})};
          if(movement.data.reservationStockEvidence&&JSON.stringify(movement.data.reservationStockEvidence)!==JSON.stringify(evidence))
            throw Error('不同倉庫的庫存預留必須分別記錄，請由管理員檢查此筆交易。');
          movement.data={...movement.data,reservationStockEvidence:evidence};
          w.data={...w.data,stockEvidence:evidence};
        }
      }
      const targets=new Map();
      writes.forEach(write=>{
        if(!enabled)return;
        const collection=write.ref.path.split('/')[0];
        if(!['inventory','warehouseStocks','inventoryLots'].includes(collection))return;
        if(write.method==='delete')throw new Error('商務角色不能刪除庫存資料。');
        const read=reads.get(write.ref.path);
        if(!read?.snapshot.exists)throw new Error('商務庫存異動必須讀取已存在的庫存。');
        const prior=targets.get(write.ref.path);
        const before=prior?.before || read.data;
        const after={...(prior?.after || before),...write.data};
        targets.set(write.ref.path,{ref:write.ref,before,after,collection});
      });
      const reservationWrites=writes.filter(write=>write.ref.path.startsWith('inventoryReservations/')&&write.method!=='delete');
      for(const target of enabled ? targets.values() : []){
        const isLot=target.collection==='inventoryLots';
        const qtyDelta=number(target.after[isLot?'remainingQty':'onHand'])-number(target.before[isLot?'remainingQty':'onHand']);
        const reservedDelta=isLot?0:number(target.after.reserved)-number(target.before.reserved);
        const productKey=target.before.productKey || target.before.productId;
        const warehouseId=target.collection==='inventory'?'':String(target.before.warehouseId||'');
        const matchingWrites=reservationWrites.filter(write=>{
          const after={...reads.get(write.ref.path)?.data,...write.data};
          return after.productKey===productKey&&(!warehouseId||after.warehouseId===warehouseId);
        });
        const reservations=matchingWrites.map(write=>({...reads.get(write.ref.path)?.data,...write.data,id:write.ref.id}));
        if(!isLot){
          // Rules remain the authority. Reject inconsistent commercial proposals
          // before generating witnesses; reuse snapshots already held by the transaction.
          const expected=matchingWrites.reduce((sum,write)=>{
            const before=reads.get(write.ref.path)?.data||{},after={...before,...write.data};
            const delta=reservationDeltas(before,after);
            return sum+(warehouseId?delta.warehouseDeltas.find(row=>row.warehouseId===warehouseId)?.reservedDelta||0:delta.companyReservedDelta);
          },0);
          if(!Number.isFinite(reservedDelta)||!Number.isFinite(expected)||Math.abs(reservedDelta-expected)>1e-9)
            throw Error('公司或分倉預留增減與來源預留不一致，已停止作業，請核對資料後重試。');
        }
        if(!qtyDelta&&!reservedDelta)continue;
        const orderIds=[...new Set(reservations.map(row=>row.orderId).filter(Boolean))];
        if(orderIds.length!==1||!reservations.length||reservations.length>5)throw new Error('庫存異動缺少唯一來源訂單或同品項預留超過 5 筆，請由管理員處理。');
        const orderId=orderIds[0];
        const sourceMovement=writes.find(write=>write.ref.path.startsWith('inventoryMovements/')&&write.data?.sourceId===orderId&&write.data?.productKey===productKey);
        const operationRef=db.collection('stockOperations').doc();
        const operation={actorUid,orderId,productKey,warehouseId,targetPath:target.ref.path,
          reservationIds:reservations.map(row=>row.id),qtyDelta,reservedDelta,
          sourceMovementId:sourceMovement?.ref.id||'',createdAt:new Date().toISOString()};
        writes.push({method:'set',ref:operationRef,data:operation});
        writes.push({method:'update',ref:target.ref,data:{stockOperationId:operationRef.id}});
        if(target.collection==='warehouseStocks'){
          for(const w of reservationWrites.filter(w=>operation.reservationIds.includes(w.ref.id)))w.data={...w.data,stockOperationId:operationRef.id,warehouseStockId:target.ref.id};
        }
      }
      if(enabled){
        for(const w of writes.filter(w=>w.ref.path.startsWith('orders/')&&w.method!=='delete')){
          const before=reads.get(w.ref.path)?.data;if(!before)continue;
          const prior=before.deliveryRecords||[],next=w.data.deliveryRecords;
          if(!Array.isArray(next)||JSON.stringify(prior)===JSON.stringify(next))continue;
          const ids=[...new Set([...prior,...next].map(r=>r.id))];
          const changed=ids.filter(id=>JSON.stringify(prior.find(r=>r.id===id))!==JSON.stringify(next.find(r=>r.id===id)));
          // Direct customer receipt has supply/receipt evidence and no physical stock operation.
          if(changed.length===1&&next.find(r=>r.id===changed[0])?.sourceType==='DIRECT_SHIP_RECEIPT')continue;
          const index=changed.length===1?(next.findIndex(r=>r.id===changed[0])>=0?next.findIndex(r=>r.id===changed[0]):prior.findIndex(r=>r.id===changed[0])):-1;
          const op=writes.find(row=>row.ref.path.startsWith('stockOperations/')&&row.data.orderId===w.ref.id&&row.data.targetPath.startsWith('inventory/'));
          w.data={...w.data,businessDeliveryEvidence:{recordIndex:index,operationId:op?.ref.id||'',inventoryId:op?.data.targetPath.split('/')[1]||''}};
        }
      }
      const supplyChanges=new Map();
      for(const write of writes){
        if(!write.ref.path.startsWith('supplyOrders/')||write.method==='delete')continue;
        const previous=supplyChanges.get(write.ref.path);
        let base=previous || reads.get(write.ref.path)?.data;
        if(!base && (write.method==='update'||write.options?.merge)){
          const snapshot=await proxy.get(write.ref);base=dataAt(snapshot);
        }
        supplyChanges.set(write.ref.path,{...(base||{}),...write.data});
      }
      for(const [path,data] of supplyChanges){
        const view=sanitizeSupply(data);
        writes.push({method:'set',ref:db.collection('receivingSupplyOrders').doc(path.split('/')[1]),data:view});
      }
      // Mark new free physical stock in the same transaction as its release.
      // Existing receipt/transfer checkpoints own their own post-receipt work.
      const stockWrites=new Map();
      for(const write of writes){
        if(!write.ref.path.startsWith('warehouseStocks/')||write.method==='delete')continue;
        if(!reads.has(write.ref.path))await proxy.get(write.ref);
        const before=reads.get(write.ref.path).data;
        const prior=stockWrites.get(write.ref.path);
        const after=write.method==='set'&&!write.options?.merge?{...write.data}:{...(prior?.after||before),...write.data};
        stockWrites.set(write.ref.path,{before,after,write});
      }
      for(const {before,after,write} of stockWrites.values()){
        const free=data=>Math.max(0,number(data.onHand)-number(data.reserved));
        if(!after.warehouseId||String(after.warehouseId).startsWith('custody-')||free(after)<=free(before))continue;
        const hasReceiptCheckpoint=writes.some(w=>
          (w.ref.path.startsWith('receipts/')&&w.data.productKey===after.productKey&&w.data.warehouseId===after.warehouseId&&number(w.data.autoAllocationQty)>0)
          ||(w.ref.path.startsWith('stockTransfers/')&&w.data.status==='RECEIVED'&&number(w.data.autoAllocationQty)>0));
        if(hasReceiptCheckpoint)continue;
        const revision=number(before.allocationRevision);
        if(!Number.isSafeInteger(revision)||revision<0||revision>=1000000000)throw Error('庫存分配進度版本不正確，請由管理員檢查。');
        write.data={...write.data,allocationRevision:revision+1,allocationPending:true};
        released.push(write.ref.id);
      }
      sessionGuard?.();
      for(const write of writes){
        if(write.method==='delete')native.delete(write.ref);
        else if(write.method==='update')native.update(write.ref,write.data);
        else if(write.options)native.set(write.ref,write.data,write.options);
        else native.set(write.ref,write.data);
      }
      return result;
    });
    if(released.length){try{root.onFreeStockReleased?.(released,actorUid,role);}catch(_){/* Durable flags remain retryable. */}}
    return result;
  }
  function sanitizeSupply(data){const {unitCost,cost,costPrice,...view}=data;return view;}
  const api={run,sanitizeSupply};root.YushinStockPermissions=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);

