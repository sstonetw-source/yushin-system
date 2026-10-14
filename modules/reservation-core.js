(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.YushinReservation=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 const n=v=>Math.max(0,Number(v||0));
 function planReservation(input={}){
   const requestedQty=n(input.requestedQty??input.qty);
   const existingQty=n(input.existingQty);
   const sameStock=!!input.sameStock;
   const availableQty=n(input.availableQty);
   const preservedQty=sameStock?Math.min(existingQty,requestedQty):0;
   const releaseQty=Math.max(0,existingQty-preservedQty);
   const additionalNeededQty=Math.max(0,requestedQty-preservedQty);
   const additionalReserveQty=Math.min(additionalNeededQty,availableQty);
   const reservedQty=preservedQty+additionalReserveQty;
   const shortageQty=Math.max(0,requestedQty-reservedQty);
   return {
     requestedQty,
     existingQty,
     sameStock,
     availableQty,
     preservedQty,
     releaseQty,
     additionalNeededQty,
     additionalReserveQty,
     reservedQty,
     shortageQty,
     status:reservedQty>0?'active':'shortage'
   };
 }
 function chooseWarehouseForReservation(input={}){
   const requestedQty=n(input.requestedQty);
   const preferredId=String(input.preferredWarehouseId||'');
   const existingId=String(input.existingWarehouseId||'');
   const existingQty=n(input.existingQty);
   const rows=(input.warehouses||[]).map(row=>({
     warehouseId:String(row.warehouseId||''),
     availableQty:n(row.availableQty)
   })).filter(row=>row.warehouseId);
   const preferred=rows.find(row=>row.warehouseId===preferredId);
   const held=existingQty>0?rows.find(row=>row.warehouseId===existingId):null;
   if(held){
     if(held.availableQty+existingQty+1e-9>=requestedQty)return held.warehouseId;
     if(rows.some(row=>row.warehouseId!==existingId&&row.availableQty>0))
       throw Error('此訂單已有預留，其他倉庫也有現貨；請先調撥到同一倉庫，再從訂單清單重試庫存同步，勿重複建單。');
     return held.warehouseId;
   }
   if(preferred&&preferred.availableQty+1e-9>=requestedQty)return preferred.warehouseId;
   const full=rows.find(row=>row.availableQty+1e-9>=requestedQty);
   if(full)return full.warehouseId;
   const best=rows.reduce((found,row)=>!found||row.availableQty>found.availableQty?row:found,null);
   const total=rows.reduce((sum,row)=>sum+row.availableQty,0);
   if(best&&best.availableQty>0&&total>best.availableQty+1e-9)
     throw Error('此產品現貨分散在多個倉庫，不能把其他倉庫的現貨當成缺貨；請先調撥到同一倉庫，再從訂單清單重試庫存同步，勿重複建單。');
   if(!(total>0)&&n(input.companyAvailableQty)>0)
     throw Error('公司總庫存顯示可用，但找不到可用分倉庫存；請先請採購核對分倉庫存，再重試訂單同步，勿重複建單。');
   if(best?.availableQty>0)return best.warehouseId;
   return preferredId||best?.warehouseId||'';
 }
 function planShortageAllocation(reservations=[],availableQty=0){
   let remaining=n(availableQty);
   const rows=reservations.map((row,index)=>({...row,__index:index}))
     .filter(row=>n(row.shortageQty)>0)
     .sort((a,b)=>String(a.orderDate||'9999-12-31').localeCompare(String(b.orderDate||'9999-12-31'))||String(a.orderId||'').localeCompare(String(b.orderId||''))||String(a.itemId||'').localeCompare(String(b.itemId||'')));
   const allocations=[];
   for(const row of rows){
     if(remaining<=0)break;
     const qty=Math.min(remaining,n(row.shortageQty));
     if(qty<=0)continue;
     allocations.push({orderId:row.orderId||'',itemId:row.itemId||'',reservationId:row.id||'',qty});
     remaining-=qty;
   }
   return {allocations,allocatedQty:n(availableQty)-remaining,remainingQty:remaining};
 }
 function allocateReceiptToShortages(reservations=[],availableQty=0){
   const plan=planShortageAllocation(reservations,availableQty);
   return {allocations:plan.allocations.map(row=>({...row,id:row.reservationId})),allocatedQty:plan.allocatedQty,unallocatedQty:plan.remainingQty};
 }
 return {planReservation,chooseWarehouseForReservation,planShortageAllocation,allocateReceiptToShortages};
});
