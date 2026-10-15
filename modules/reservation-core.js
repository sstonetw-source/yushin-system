(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.YushinReservation=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 const n=v=>Math.max(0,Number(v||0));
 function compareReservationPriority(a={},b={}){
   return String(a.orderDate||'9999-12-31').localeCompare(String(b.orderDate||'9999-12-31'))
     ||String(a.orderId||'').localeCompare(String(b.orderId||''))
     ||String(a.itemId||'').localeCompare(String(b.itemId||''))
     ||String(a.id||'').localeCompare(String(b.id||''));
 }
 function reservationLocationCanChange(item={},reservation={},demand={}){
   return !item.transferPendingId&&!item.custodyTransferId
     && !String(item.warehouseId||'').startsWith('custody-')
     && [reservation.quantity,item.reservedQty,item.supplyOrderedQty,item.receivedQty,
       item.dispatchPreparedQty,item.deliveredQty,item.returnedQty,demand.orderedQty,demand.receivedQty]
       .every(value=>n(value)===0);
 }
 // The legacy fulfillment model has one location per item. A whole-item choice
 // is safe; combining partial locations requires a separate quantity ledger.
 function selectSingleWarehouse({warehouses=[],stocks={},currentWarehouseId='',requestedQty=0,aggregateAvailableQty=0}={}){
   const eligible=warehouses.filter(w=>w.active!==false&&!w.systemCustody&&!String(w.id).startsWith('custody-'))
     .sort((a,b)=>Number(b.id===currentWarehouseId)-Number(a.id===currentWarehouseId)
       ||Number(!!b.isDefault)-Number(!!a.isDefault)||String(a.id).localeCompare(String(b.id)));
   const needed=n(requestedQty);
   const available=id=>Math.max(0,n(stocks[id]?.onHand)-n(stocks[id]?.reserved));
   let selected=needed>0&&n(aggregateAvailableQty)>=needed
     ? eligible.find(w=>n(stocks[w.id]?.onHand)-n(stocks[w.id]?.reserved)>=needed) : null;
   const stocked=eligible.filter(w=>available(w.id)>0);
   if(!selected&&needed>0&&stocked.length===1&&n(aggregateAvailableQty)>=available(stocked[0].id))selected=stocked[0];
   const warehouseId=(selected||eligible[0])?.id||'';
   const requiresMultipleLocations=!selected&&needed>available(warehouseId)
     && n(aggregateAvailableQty)>available(warehouseId)
     && eligible.some(w=>w.id!==warehouseId&&available(w.id)>0);
   return {warehouseId,requiresMultipleLocations};
 }
 // Pure planner only: does not mutate legacy one-location reservations.
 function planMultiWarehouseReservation({warehouses=[],stocks={},requestedQty=0,currentWarehouseId=''}={}){
   const needed=n(requestedQty);
   const eligible=warehouses.filter(w=>w&&w.active!==false&&!w.systemCustody&&w.warehouseType!=='CUSTODY'&&!String(w.id||'').startsWith('custody-'))
     .sort((a,b)=>Number(b.id===currentWarehouseId)-Number(a.id===currentWarehouseId)
       ||Number(!!b.isDefault)-Number(!!a.isDefault)||String(a.id).localeCompare(String(b.id)));
   let remaining=needed;
   const allocations=[];
   for(const warehouse of eligible){
     if(remaining<=0)break;
     const stock=stocks[warehouse.id]||{};
     const available=Math.max(0,n(stock.onHand)-n(stock.reserved));
     const qty=Math.min(remaining,available);
     if(qty>0){allocations.push({warehouseId:warehouse.id,qty});remaining-=qty;}
   }
   return {requestedQty:needed,allocations,allocatedQty:needed-remaining,shortageQty:remaining};
 }
 function planReservation(input={}){
   const requestedQty=n(input.requestedQty??input.qty);
   const existingQty=n(input.existingQty);
   const sameStock=!!input.sameStock;
   const availableQty=n(input.availableQty);
   const inTransitQty=n(input.inTransitQty);
   const preservedQty=sameStock?Math.min(existingQty,requestedQty):0;
   const releaseQty=Math.max(0,existingQty-preservedQty);
   const additionalNeededQty=Math.max(0,requestedQty-preservedQty-inTransitQty);
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
 function planShortageAllocation(reservations=[],availableQty=0){
   let remaining=n(availableQty);
   const rows=reservations.filter(row=>n(row.shortageQty)>0).sort(compareReservationPriority);
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
 return {planMultiWarehouseReservation,planReservation,planShortageAllocation,allocateReceiptToShortages,reservationLocationCanChange,selectSingleWarehouse,compareReservationPriority};
});
