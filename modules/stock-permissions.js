// Record the source and numerical changes of commercial stock transactions.
// Firestore Rules validate these witnesses against the same atomic order/reservation writes.
(function(root){
  function dataAt(snapshot){return snapshot?.exists ? snapshot.data() : {};}
  function number(value){return Number(value || 0);}
  async function run(db, callback, actorUid, enabled, role){
    return db.runTransaction(async native=>{
      const reads=new Map(),writes=[];
      const sourceRef=ref=>ref.path.startsWith('receivingSupplyOrders/')?db.collection('supplyOrders').doc(ref.id):ref;
      const proxy={
        async get(ref){ref=sourceRef(ref);const readRef=role==='warehouse'&&ref.path.startsWith('supplyOrders/')?db.collection('receivingSupplyOrders').doc(ref.id):ref;const snapshot=await native.get(readRef);reads.set(ref.path,{ref,snapshot,data:dataAt(snapshot)});return snapshot;},
        set(ref,data,options){ref=sourceRef(ref);writes.push({method:'set',ref,data,options});return proxy;},
        update(ref,data){ref=sourceRef(ref);writes.push({method:'update',ref,data});return proxy;},
        delete(ref){ref=sourceRef(ref);writes.push({method:'delete',ref});return proxy;}
      };
      const result=await callback(proxy);
      if(enabled){
        for(const write of writes){
          if(!write.ref.path.startsWith('inventoryReservations/')||write.method==='delete')continue;
          const reservation={...reads.get(write.ref.path)?.data,...write.data};
          const orderRef=db.collection('orders').doc(reservation.orderId);
          let orderData=reads.get(orderRef.path)?.data;
          if(!orderData){const snapshot=await proxy.get(orderRef);orderData=dataAt(snapshot);}
          const orderWrites=writes.filter(row=>row.ref.path===orderRef.path&&row.method!=='delete');
          const afterOrder=orderWrites.reduce((data,row)=>({...data,...row.data}),orderData);
          const index=(afterOrder.items||[]).findIndex((item,i)=>String(item.itemId||`item-${i+1}`)===reservation.itemId);
          if(index<0)throw new Error('庫存占用缺少對應的來源訂單品項。');
          write.data={...write.data,orderItemIndex:index};
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
        if(!qtyDelta&&!reservedDelta)continue;
        const productKey=target.before.productKey || target.before.productId;
        const warehouseId=target.collection==='inventory'?'':String(target.before.warehouseId||'');
        const reservations=reservationWrites.map(write=>({id:write.ref.id,...reads.get(write.ref.path)?.data,...write.data}))
          .filter(row=>row.productKey===productKey&&(!warehouseId||row.warehouseId===warehouseId));
        const orderIds=[...new Set(reservations.map(row=>row.orderId).filter(Boolean))];
        if(orderIds.length!==1||!reservations.length||reservations.length>5)throw new Error('庫存異動缺少唯一來源訂單或同品項占用超過 5 筆，請由管理員處理。');
        const orderId=orderIds[0];
        const sourceMovement=writes.find(write=>write.ref.path.startsWith('inventoryMovements/')&&write.data?.sourceId===orderId&&write.data?.productKey===productKey);
        const operationRef=db.collection('stockOperations').doc();
        const operation={actorUid,orderId,productKey,warehouseId,targetPath:target.ref.path,
          reservationIds:reservations.map(row=>row.id),qtyDelta,reservedDelta,
          sourceMovementId:sourceMovement?.ref.id||'',createdAt:new Date().toISOString()};
        writes.push({method:'set',ref:operationRef,data:operation});
        writes.push({method:'update',ref:target.ref,data:{stockOperationId:operationRef.id}});
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
      for(const write of writes){
        if(write.method==='delete')native.delete(write.ref);
        else if(write.method==='update')native.update(write.ref,write.data);
        else if(write.options)native.set(write.ref,write.data,write.options);
        else native.set(write.ref,write.data);
      }
      return result;
    });
  }
  function sanitizeSupply(data){const {unitCost,cost,costPrice,...view}=data;return view;}
  const api={run,sanitizeSupply};root.YushinStockPermissions=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
