(function(root,factory){
 const inventory=typeof module==='object'&&module.exports?require('./inventory-core.js'):root?.YushinInventory;
 const api=factory(inventory);
 if(typeof module==='object'&&module.exports)module.exports=api;
 if(root)root.YushinReservation=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(inventory){
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
 // New location APIs fail closed on malformed quantities. Do not silently turn
 // a corrupt ledger into zero stock or overwrite the legacy reservation.
 function locationQty(value=0){
   if(!['number','string'].includes(typeof value)||String(value).trim()===''
     ||!Number.isSafeInteger(Number(value))||Number(value)<0)
     throw new Error('多倉預留數量不正確，請先核對資料。');
   return Number(value);
 }
 function locationId(value){
   if(typeof value!=='string'||!value.trim()||value!==value.trim())
     throw new Error('多倉預留缺少有效倉庫識別碼。');
   return value;
 }
 function physicalWarehouse(w){
   return w.active!==false&&!w.systemCustody&&w.warehouseType!=='CUSTODY'&&!w.id.startsWith('custody-');
 }
 function locationWarehouses(warehouses,currentWarehouseId){
   const ids=new Set();
   for(const w of warehouses){
     const id=locationId(w?.id);
     if(ids.has(id))throw new Error('多倉預留的倉庫主檔重複。');
     ids.add(id);
   }
   return warehouses.filter(physicalWarehouse)
     .sort((a,b)=>Number(b.id===currentWarehouseId)-Number(a.id===currentWarehouseId)
       ||Number(!!b.isDefault)-Number(!!a.isDefault)||String(a.id).localeCompare(String(b.id)));
 }
 function locationAvailable(stock={}){
   if(!inventory?.normalizeStock)throw new Error('Inventory core 未載入，無法計算多倉可用量。');
   return inventory.normalizeStock({onHand:locationQty(stock.onHand),reserved:locationQty(stock.reserved),
     transferFreeInTransit:locationQty(stock.transferFreeInTransit)}).available;
 }
 // Pure planner only: does not mutate legacy one-location reservations.
 // aggregateStock is optional for compatibility with the first-stage preview;
 // reconciliation below always requires the company-level ceiling.
 function planMultiWarehouseReservation({warehouses=[],stocks={},requestedQty=0,currentWarehouseId='',aggregateStock}={}){
   const needed=locationQty(requestedQty);
   const eligible=locationWarehouses(warehouses,currentWarehouseId);
   let remaining=needed;
   let companyAvailable=aggregateStock===undefined?needed:locationAvailable(aggregateStock);
   const allocations=[];
   for(const warehouse of eligible){
     if(remaining<=0)break;
     const stock=stocks[warehouse.id]||{};
     const qty=Math.min(remaining,locationAvailable(stock),companyAvailable);
     if(qty>0){allocations.push({warehouseId:warehouse.id,qty});remaining-=qty;companyAvailable-=qty;}
   }
   return {requestedQty:needed,allocations,allocatedQty:needed-remaining,shortageQty:remaining};
 }
 // Canonical per-location quantity model. No writes until transaction and Rules are migrated.
 function validateMultiLocationLedger({requestedQty=0,locations=[]}={}){
   if(!Number.isSafeInteger(requestedQty)||requestedQty<0)throw Error('訂單數量必須為非負整數。');
   if(!Array.isArray(locations))throw Error('倉庫分配明細格式不正確。');
   const seen=new Set();let reservedQty=0;const normalized=[];
   for(const location of locations){
     const warehouseId=String(location?.warehouseId||'').trim();
     const qty=location?.reservedQty;
     if(!warehouseId||warehouseId.startsWith('custody-')||seen.has(warehouseId))throw Error('倉庫分配位置重複或不正確。');
     if(!Number.isSafeInteger(qty)||qty<=0)throw Error('各倉預留數量必須為正整數。');
     seen.add(warehouseId);reservedQty+=qty;
     if(!Number.isSafeInteger(reservedQty)||reservedQty>requestedQty)throw Error('各倉預留總量超過訂購量。');
     normalized.push({warehouseId,reservedQty:qty});
   }
   return {requestedQty,locations:normalized,reservedQty,shortageQty:requestedQty-reservedQty};
 }
 // One deterministic reservation document per order/item remains the authority.
 // V2 stores its quantities per location; it is NOT a second stock collection.
 function reservationLocations(reservation={}){
   const quantity=locationQty(reservation.quantity);
   if(reservation.locationSchemaVersion===undefined){
     if(reservation.locations!==undefined||reservation.allocations!==undefined)throw new Error('多倉預留缺少位置版本，不可當成舊單覆寫。');
     return quantity>0?[{warehouseId:locationId(reservation.warehouseId),qty:quantity}]:[];
   }
   if(reservation.locationSchemaVersion!==2||!Array.isArray(reservation.locations))
     throw new Error('不支援的多倉預留位置版本。');
   for(const row of reservation.locations)locationId(row?.warehouseId);
   const ledger=validateMultiLocationLedger({requestedQty:quantity,locations:reservation.locations});
   if(ledger.reservedQty!==quantity)
     throw new Error('多倉預留總量與各倉數量不一致，請先稽核。');
   return ledger.locations.map(row=>({warehouseId:row.warehouseId,qty:row.reservedQty}))
     .sort((a,b)=>a.warehouseId.localeCompare(b.warehouseId));
 }
 // Returns a proposed atomic change, never writes Firestore. The caller must
 // re-read all sources inside the SAME transaction before applying any deltas.
 // No relocation: existing quantities stay in their warehouse; a disabled
 // physical location may be released, but cannot receive additional holds.
 function planLocationReservation({productKey,warehouses=[],stocks={},aggregateStock,reservation={},
   requestedQty=0,inTransitQty=0,currentWarehouseId=''}={}){
   if(typeof productKey!=='string'||!productKey||!aggregateStock)
     throw new Error('多倉預留缺少產品或公司庫存。');
   const checkProduct=data=>{
     if(data.productKey!==undefined&&data.productKey!==productKey)
       throw new Error('多倉預留產品不一致，不可跨產品配置。');
   };
   checkProduct(reservation);checkProduct(aggregateStock);
   locationWarehouses(warehouses,currentWarehouseId);
   for(const w of warehouses){
     const stock=stocks[w.id];if(!stock)continue;
     checkProduct(stock);
     if(stock.warehouseId!==undefined&&stock.warehouseId!==w.id)
       throw new Error('多倉預留分倉位置不一致。');
   }
   const requested=locationQty(requestedQty),incoming=locationQty(inTransitQty);
   const before=reservationLocations(reservation),existingQty=locationQty(reservation.quantity);
   if(locationQty(aggregateStock.reserved)<existingQty)
     throw new Error('公司預留量少於本品項預留，請先稽核。');
   const kept=new Map(),previous=new Map(before.map(row=>[row.warehouseId,row.qty]));
   let remaining=requested;
   for(const row of before){
     const master=warehouses.find(w=>w.id===row.warehouseId),stock=stocks[row.warehouseId];
     if(!master||master.systemCustody||master.warehouseType==='CUSTODY'||row.warehouseId.startsWith('custody-'))
       throw new Error('既有預留位置缺失或在業務保管中，需使用對應履約流程。');
     if(!stock||locationQty(stock.reserved)<row.qty||locationQty(stock.onHand)<row.qty)
       throw new Error('既有預留缺少足量分倉庫存，請先稽核。');
     const qty=Math.min(remaining,row.qty);if(qty)kept.set(row.warehouseId,qty);remaining-=qty;
   }
   const preservedQty=requested-remaining;
   // Supplier commitments cover the physical shortage but must not be counted
   // as stock. Preserve actual holds even if a historical supply overcommits.
   const additional=planMultiWarehouseReservation({warehouses,stocks,aggregateStock,currentWarehouseId,
     requestedQty:Math.max(0,requested-preservedQty-incoming)});
   for(const row of additional.allocations)kept.set(row.warehouseId,(kept.get(row.warehouseId)||0)+row.qty);
   const allocations=[...kept].map(([warehouseId,qty])=>({warehouseId,qty}))
     .sort((a,b)=>a.warehouseId.localeCompare(b.warehouseId));
   const ledger=validateMultiLocationLedger({requestedQty:requested,
     locations:allocations.map(row=>({warehouseId:row.warehouseId,reservedQty:row.qty}))});
   const quantity=ledger.reservedQty;
   const warehouseDeltas=[...new Set([...previous.keys(),...kept.keys()])].sort().map(warehouseId=>({
     warehouseId,reservedDelta:(kept.get(warehouseId)||0)-(previous.get(warehouseId)||0)
   })).filter(row=>row.reservedDelta!==0);
   return {reservation:{locationSchemaVersion:2,locations:ledger.locations,quantity,shortageQty:ledger.shortageQty,
       status:quantity>0?'active':'shortage'},
     warehouseDeltas,companyReservedDelta:quantity-existingQty,
     remainingToOrderQty:Math.max(0,requested-quantity-incoming)};
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
 return {validateMultiLocationLedger,planLocationReservation,reservationLocations,planMultiWarehouseReservation,planReservation,planShortageAllocation,allocateReceiptToShortages,reservationLocationCanChange,selectSingleWarehouse,compareReservationPriority};
});
