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
   const eligible=locationWarehouses(warehouses,currentWarehouseId);
   const needed=n(requestedQty);
   const available=id=>inventory.normalizeStock(stocks[id]||{}).available;
   let selected=needed>0&&n(aggregateAvailableQty)>=needed
     ? eligible.find(w=>available(w.id)>=needed) : null;
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
 // Resolve a whole-item transfer source without flattening a v2 ledger.
 // This validates source only; it does not authorize a legacy writer to move v2.
 // Resolve every authoritative held location before composing a physical transfer.
 // This is a read-only source check: a v2 ledger must never be flattened into a legacy warehouseId.
 function orderTransferReservationSources({reservation,item,orderId,itemId,productKey,qty}={}){
   if(!reservation||!item||typeof qty!=='number'||!Number.isFinite(qty)||qty<=0)
     throw Error('訂單調撥預留來源不正確。');
   for(const [field,expected] of [['orderId',orderId],['itemId',itemId],['productKey',productKey]]){
     if(typeof expected!=='string'||!expected||expected.includes('/')
       ||(reservation[field]!==undefined&&reservation[field]!==expected)
       ||(reservation.locationSchemaVersion===2&&reservation[field]!==expected))
       throw Error('訂單調撥預留來源識別不一致。');
   }
   if(item.itemId!==itemId||item.transferPendingId||item.custodyTransferId)
     throw Error('訂單品項已有調撥或交接，不能重複移動。');
   const held=legacyReservationQty(reservation.quantity),projected=legacyReservationQty(item.reservedQty);
   if(Math.abs(held-qty)>1e-9||Math.abs(projected-qty)>1e-9
     ||legacyReservationQty(reservation.shortageQty??0)!==0)
     throw Error('訂單調撥須全數預留，數量或缺貨狀態不一致。');
   if(reservation.locationSchemaVersion===undefined){
     if(reservation.locations!==undefined||reservation.allocations!==undefined)
       throw Error('單倉調撥不可混用多倉預留格式。');
     const warehouseId=reservation.warehouseId;
     if(typeof warehouseId!=='string'||!warehouseId||warehouseId!==warehouseId.trim()
       ||warehouseId.includes('/')||warehouseId.startsWith('custody-'))
       throw Error('單倉調撥預留位置不一致。');
     return {schemaVersion:1,qty,sources:[{warehouseId,qty}]};
   }
   if(reservation.locationSchemaVersion!==2||reservation.warehouseId!==undefined)
     throw Error('多倉預留版本或單倉欄位不一致。');
   const sources=reservationLocations(reservation);
   if(!sources.length||sources.some(row=>row.warehouseId.includes('/')||row.warehouseId.startsWith('custody-')))
     throw Error('多倉調撥來源位置不正確。');
   return {schemaVersion:2,qty,sources};
 }
 // Build source legs without changing a v2 reservation, moving only quantities
 // outside the selected destination. No physical or ledger write is authorized here.
 function planOrderTransferTarget({reservation,item,orderId,itemId,productKey,qty,toWarehouseId,action='DISPATCH',ownerUid=''}={}){
   if(!['DISPATCH','HANDOFF'].includes(action)
     ||typeof toWarehouseId!=='string'||!toWarehouseId||toWarehouseId!==toWarehouseId.trim()||toWarehouseId.includes('/'))
     throw Error('訂單調撥目的位置或動作不正確。');
   const source=orderTransferReservationSources({reservation,item,orderId,itemId,productKey,qty});
   const isCustody=toWarehouseId.startsWith('custody-');
   if(action==='HANDOFF'){
     if(typeof ownerUid!=='string'||!ownerUid||ownerUid.includes('/')
       ||toWarehouseId!=='custody-'+ownerUid)throw Error('業務交接目的地必須屬於目前訂單負責人。');
   }else if(isCustody)throw Error('一般倉庫調撥不得直接寫入業務保管位置。');
   if(source.schemaVersion===2){
     const candidates=reservation.lifecycleWarehouseIds;
     if(!Array.isArray(candidates)||candidates.length!==2||new Set(candidates).size!==2
       ||candidates.some(w=>typeof w!=='string'||!w||w!==w.trim()||w.includes('/')||w.startsWith('custody-'))
       ||!candidates.includes(item.warehouseId)
       ||source.sources.some(row=>!candidates.includes(row.warehouseId))
       ||(action==='DISPATCH'&&!candidates.includes(toWarehouseId)))
       throw Error('多倉調撥來源與原兩個候選實體倉不一致。');
   }else if(item.warehouseId!==source.sources[0].warehouseId)
     throw Error('原單倉調撥位置與訂單指定倉不一致。');
   const keptQty=source.sources.find(row=>row.warehouseId===toWarehouseId)?.qty||0;
   const moveLegs=source.sources.filter(row=>row.warehouseId!==toWarehouseId)
     .map(row=>({warehouseId:row.warehouseId,qty:row.qty}));
   const movingQty=moveLegs.reduce((sum,row)=>sum+row.qty,0);
   if(!moveLegs.length||Math.abs(movingQty+keptQty-source.qty)>1e-9)
     throw Error('調撥沒有需要移動的預留，或分倉總量不一致。');
   return {schemaVersion:source.schemaVersion,orderQty:source.qty,destinationWarehouseId:toWarehouseId,
     sourceLocations:source.sources,moveLegs,movingQty,keptQty};
 }
 // Compatibility guard: existing single-source callers must not silently start moving distributed holds.
 function orderTransferReservationSource(input={}){
   const warehouseId=input.warehouseId;
   if(typeof warehouseId!=='string'||!warehouseId||warehouseId!==warehouseId.trim()||warehouseId.includes('/'))
     throw Error('訂單調撥預留來源不正確。');
   const resolved=orderTransferReservationSources(input);
   if(resolved.sources.length!==1||resolved.sources[0].warehouseId!==warehouseId
     ||Math.abs(resolved.sources[0].qty-resolved.qty)>1e-9)
     throw Error('調撥來源仍分散於多倉，須由受控後端處理。');
   return {schemaVersion:resolved.schemaVersion,warehouseId,qty:resolved.qty};
 }
 // Legacy stock and fulfillment can contain fractional quantities. Validate
 // without clamping corrupt values into a smaller release or a new reservation.
 function legacyReservationQty(value=0){
   if(!['number','string'].includes(typeof value)||String(value).trim()===''
     ||!Number.isFinite(Number(value))||Number(value)<0||Number(value)>Number.MAX_SAFE_INTEGER)
     throw Error('預留數量不正確，請先核對資料。');
   return Number(value);
 }
 function validateReservationBalance({existingQty=0,itemReservedQty=existingQty,aggregateStock,warehouseStock}={}){
   const existing=legacyReservationQty(existingQty),projected=legacyReservationQty(itemReservedQty);
   if(Math.abs(existing-projected)>1e-9)throw Error('訂單與庫存預留數量不一致，請先核對資料。');
   const stock=data=>{
     const numbers={onHand:legacyReservationQty(data?.onHand),reserved:legacyReservationQty(data?.reserved),
       transferFreeInTransit:legacyReservationQty(data?.transferFreeInTransit)};
     if(numbers.reserved>numbers.onHand+1e-9||existing>numbers.reserved+1e-9)
       throw Error('公司或分倉預留量不足或異常，不可縮減釋放量，請先核對資料。');
     return numbers;
   };
   return {existingQty:existing,company:stock(aggregateStock),warehouse:stock(warehouseStock)};
 }
 function validateReservationStockIdentity({productKey,warehouseId,reservation,aggregateStock,warehouseStock}){
   if(typeof productKey!=='string'||!productKey)throw Error('庫存作業缺少產品識別碼。');
   locationId(warehouseId);
   if(!aggregateStock||!warehouseStock)throw Error('庫存作業缺少公司或分倉庫存，請先核對資料。');
   for(const data of [reservation,aggregateStock,warehouseStock]){
     if(data.productKey!==undefined&&data.productKey!==productKey)
       throw Error('產品與預留或庫存不一致，請先核對資料。');
   }
   if(warehouseStock.warehouseId!==undefined&&warehouseStock.warehouseId!==warehouseId)
     throw Error('倉庫與分倉庫存位置不一致。');
 }
 // One physical issue consumes only the selected location. This is a pure
 // proposal; dispatch eligibility, lots, transaction identity and Rules remain
 // the responsibility of the existing fulfillment transaction.
 function planReservationIssue({productKey,warehouseId,qty,reservation={},aggregateStock,warehouseStock,
   requireReservation=true,itemReservedQty}={}){
   validateReservationStockIdentity({productKey,warehouseId,reservation,aggregateStock,warehouseStock});
   if(typeof requireReservation!=='boolean')throw Error('出貨預留要求格式不正確。');
   const multi=reservation.locationSchemaVersion===2;
   // Reuse canonical format checks, including unknown/mixed location markers.
   reservationStockDeltas(reservation,reservation);
   const quantity=legacyReservationQty(reservation.quantity);
   const shortageQty=multi?locationQty(reservation.shortageQty):0;
   const issueQty=multi?locationQty(qty):legacyReservationQty(qty);
   if(issueQty<=0)throw Error('出貨數量必須大於 0。');
   const locations=multi?reservationLocations(reservation)
     :quantity>0?[{warehouseId:locationId(reservation.warehouseId),qty:quantity}]:[];
   const localQty=locations.find(row=>row.warehouseId===warehouseId)?.qty||0;
   if(!multi&&quantity>0&&reservation.warehouseId!==warehouseId)
     throw Error('出貨來源倉庫與既有預留位置不一致。');
   if(itemReservedQty!==undefined&&Math.abs(legacyReservationQty(itemReservedQty)-quantity)>1e-9)
     throw Error('訂單與庫存預留數量不一致，請先核對資料。');
   const {company,warehouse}=validateReservationBalance({existingQty:localQty,aggregateStock,warehouseStock});
   if(company.reserved<quantity||warehouse.reserved<localQty)throw Error('公司或分倉預留量不足，請先核對資料。');
   for(const stock of [company,warehouse]){
     if(multi)for(const value of Object.values(stock))locationQty(value);
     if(stock.reserved+stock.transferFreeInTransit>stock.onHand)
       throw Error('預留與自由調撥途中量超過實貨，請先核對庫存。');
   }
   if((requireReservation||multi)&&issueQty>localQty)
     throw Error('指定倉庫的訂單預留數量不足，不可挪用其他倉或其他訂單的預留。');
   const consumed=Math.min(localQty,issueQty),unreservedQty=issueQty-consumed;
   if(company.onHand<issueQty||warehouse.onHand<issueQty
     ||inventory.normalizeStock(company).available<unreservedQty
     ||inventory.normalizeStock(warehouse).available<unreservedQty)
     throw Error('公司或指定倉庫可出貨實貨不足，不可使用其他訂單預留或調撥途中庫存。');
   const next={...reservation,quantity:quantity-consumed,
     status:quantity>consumed?'active':(multi&&shortageQty>0?'shortage':'fulfilled')};
   if(multi)next.locations=locations.map(row=>({warehouseId:row.warehouseId,
     reservedQty:row.qty-(row.warehouseId===warehouseId?consumed:0)})).filter(row=>row.reservedQty>0);
   const deltas=reservationStockDeltas(reservation,next);
   return {reservation:next,reservedDelta:deltas.companyReservedDelta,unreservedQty,
     aggregateStock:{onHand:company.onHand-issueQty,reserved:company.reserved+deltas.companyReservedDelta},
     warehouseStock:{onHand:warehouse.onHand-issueQty,
       reserved:warehouse.reserved+(deltas.warehouseDeltas.find(row=>row.warehouseId===warehouseId)?.reservedDelta||0)}};
 }
 // Restore real stock without reinterpreting cancellation or closed returns
 // in a page. Single-location accounting only; the shared delta projection
 // refuses touching another location through this scalar stock contract.
 function planReservationReturn({operation,deltaQty,orderStatus='normal',settlement='REPLACE',
   productKey,warehouseId,reservation={},aggregateStock,warehouseStock,itemReservedQty}={}){
   if(!['SHIP_REVERSAL','CUSTOMER_RETURN'].includes(operation))throw Error('不支援的庫存還原作業。');
   if(!['normal','cancelled'].includes(orderStatus)||!['REPLACE','CLOSE'].includes(settlement))
     throw Error('訂單或退貨結案狀態不正確。');
   if(!['number','string'].includes(typeof deltaQty)||String(deltaQty).trim()===''
     ||!Number.isFinite(Number(deltaQty))||Number(deltaQty)===0||Math.abs(Number(deltaQty))>Number.MAX_SAFE_INTEGER)
     throw Error('庫存還原數量不正確，請先核對資料。');
   const delta=Number(deltaQty);
   if(operation==='SHIP_REVERSAL'&&delta<0)throw Error('送貨撤銷還原數量必須大於零。');
   validateReservationStockIdentity({productKey,warehouseId,reservation,aggregateStock,warehouseStock});
   // V2 customer receipts restore only their source location, retaining holds
   // in every other warehouse. Corrections/cancellation still use a separate
   // lifecycle contract; a cancelled CLOSE receipt requires an already empty
   // released ledger and must never recreate or silently release a hold.
   if(reservation.locationSchemaVersion===2&&operation==='CUSTOMER_RETURN'&&delta>0){
     reservationStockDeltas(reservation,reservation);
     if(reservation.warehouseId!==undefined)throw Error('多倉預留不可含單倉位置。');
     const amount=locationQty(delta),existing=locationQty(reservation.quantity),shortage=locationQty(reservation.shortageQty);
     if(itemReservedQty!==undefined&&locationQty(itemReservedQty)!==existing)throw Error('訂單與庫存預留數量不一致。');
     const locations=reservationLocations(reservation),local=locations.find(row=>row.warehouseId===warehouseId)?.qty||0;
     if(orderStatus==='cancelled'&&(settlement!=='CLOSE'||reservation.status!=='released'
       ||existing!==0||shortage!==0||locations.length!==0))
       throw Error('取消的多倉退貨只支援已完整釋放的 CLOSE 入庫。');
     const {company,warehouse}=validateReservationBalance({existingQty:local,aggregateStock,warehouseStock});
     if(company.reserved<existing)throw Error('公司預留量不足。');
     for(const stock of [company,warehouse]){
       Object.values(stock).forEach(locationQty);
       if(stock.reserved+stock.transferFreeInTransit>stock.onHand)throw Error('預留與自由調撥途中量超過實貨。');
     }
     const added=settlement==='REPLACE'?amount:0,quantity=locationQty(existing+added);
     const nextLocations=new Map(locations.map(row=>[row.warehouseId,row.qty]));
     if(added)nextLocations.set(warehouseId,locationQty(local+added));
     const next={...reservation,quantity,status:orderStatus==='cancelled'?'released':quantity?'active':shortage?'shortage':'fulfilled',
       locations:[...nextLocations].sort(([a],[b])=>a.localeCompare(b)).map(([warehouseId,reservedQty])=>({warehouseId,reservedQty}))};
     const changes=reservationStockDeltas(reservation,next);
     return {reservation:next,reservedDelta:changes.companyReservedDelta,
       aggregateStock:{onHand:locationQty(company.onHand+amount),reserved:locationQty(company.reserved+added)},
       warehouseStock:{onHand:locationQty(warehouse.onHand+amount),reserved:locationQty(warehouse.reserved+added)}};
   }
   const held=reservationStockDeltas({},reservation);
   if(held.warehouseDeltas.some(row=>row.warehouseId!==warehouseId))
     throw Error('還原來源倉庫與既有預留位置不一致，不能以單倉作業修改其他位置。');
   const {existingQty:existing,company,warehouse}=validateReservationBalance({existingQty:reservation.quantity,
     itemReservedQty,aggregateStock,warehouseStock});
   let quantity=orderStatus==='cancelled'?0:
     (operation==='SHIP_REVERSAL'||settlement!=='CLOSE'?existing+delta:existing);
   quantity=legacyReservationQty(quantity);
   const next={...reservation,quantity,status:orderStatus==='cancelled'?'released':quantity>0?'active':'fulfilled'};
   if(reservation.locationSchemaVersion===2){
     locationQty(quantity);
     next.locations=quantity>0?[{warehouseId,reservedQty:quantity}]:[];
   }else if(quantity>0)next.warehouseId=warehouseId;
   const changes=reservationStockDeltas(reservation,next);
   const project=(stock,reservedDelta)=>{
     if(stock.reserved+stock.transferFreeInTransit>stock.onHand)
       throw Error('預留與自由調撥途中量超過實貨，請先核對庫存。');
     const onHand=legacyReservationQty(stock.onHand+delta),reserved=legacyReservationQty(stock.reserved+reservedDelta);
     if(reserved+stock.transferFreeInTransit>onHand)
       throw Error('還原後公司或分倉可用庫存不足，不可扣用其他訂單預留或調撥途中量。');
     return {onHand,reserved};
   };
   return {reservation:next,reservedDelta:changes.companyReservedDelta,
     aggregateStock:project(company,changes.companyReservedDelta),
     warehouseStock:project(warehouse,changes.warehouseDeltas.find(row=>row.warehouseId===warehouseId)?.reservedDelta||0)};
 }
 // Receipt stock belongs only to the actual receiving location. Source
 // receipt demand comes from Receiving/Workflow; free stock demand comes from
 // the existing procurement projection. This planner never chooses another warehouse.
 function planReservationReceipt({productKey,warehouseId,qty,requestedReserveQty,reservation={},
   aggregateStock,warehouseStock,addsStock=true,itemReservedQty}={}){
   if(typeof addsStock!=='boolean')throw Error('收貨庫存異動模式不正確。');
   validateReservationStockIdentity({productKey,warehouseId,reservation,aggregateStock,warehouseStock});
   const held=reservationStockDeltas({},reservation),multi=reservation.locationSchemaVersion===2;
   const quantity=legacyReservationQty(reservation.quantity),shortage=legacyReservationQty(reservation.shortageQty);
   const amount=legacyReservationQty(qty),requested=legacyReservationQty(requestedReserveQty);
   if(itemReservedQty!==undefined&&Math.abs(legacyReservationQty(itemReservedQty)-quantity)>1e-9)
     throw Error('訂單與庫存預留數量不一致，請先核對資料。');
   if(!multi&&held.warehouseDeltas.some(row=>row.warehouseId!==warehouseId))
     throw Error('收貨倉與既有單倉預留位置不一致。');
   const locations=multi?reservationLocations(reservation):held.warehouseDeltas.map(row=>({warehouseId:row.warehouseId,qty:row.reservedDelta}));
   const localQty=locations.find(row=>row.warehouseId===warehouseId)?.qty||0;
   const {company,warehouse}=validateReservationBalance({existingQty:localQty,aggregateStock,warehouseStock});
   if(company.reserved<quantity||warehouse.reserved<localQty)throw Error('公司或收貨倉預留量不足，請先核對資料。');
   for(const stock of [company,warehouse]){
     if(stock.reserved+stock.transferFreeInTransit>stock.onHand)throw Error('預留與自由調撥途中量超過實貨，請先核對庫存。');
     if(multi)for(const value of Object.values(stock))locationQty(value);
   }
   if(multi)for(const value of [quantity,shortage,amount,requested])locationQty(value);
   const physicalDelta=addsStock?amount:0;
   const afterCompany={...company,onHand:legacyReservationQty(company.onHand+physicalDelta)};
   const afterWarehouse={...warehouse,onHand:legacyReservationQty(warehouse.onHand+physicalDelta)};
   const take=Math.min(amount,requested,shortage,inventory.normalizeStock(afterCompany).available,
     inventory.normalizeStock(afterWarehouse).available);
   const next={...reservation,quantity:legacyReservationQty(quantity+take),shortageQty:shortage-take,
     status:quantity+take>0?'active':'shortage'};
   if(multi){
     const rows=new Map(locations.map(row=>[row.warehouseId,row.qty]));
     if(take>0)rows.set(warehouseId,localQty+take);
     next.locations=[...rows].sort(([a],[b])=>a.localeCompare(b)).map(([id,qty])=>({warehouseId:id,reservedQty:qty}));
   }else next.warehouseId=warehouseId;
   const changes=reservationStockDeltas(reservation,next);
   return {reservation:next,allocatedQty:take,reservedDelta:changes.companyReservedDelta,
     aggregateStock:{onHand:afterCompany.onHand,reserved:company.reserved+changes.companyReservedDelta},
     warehouseStock:{onHand:afterWarehouse.onHand,
       reserved:warehouse.reserved+(changes.warehouseDeltas.find(row=>row.warehouseId===warehouseId)?.reservedDelta||0)}};
 }
 function planReservationLifecycle({nextStatus,existingQty=0,itemReservedQty=existingQty,
   requestedQty=0,inTransitQty=0,aggregateStock,warehouseStock}={}){
   if(!['normal','cancelled'].includes(nextStatus))throw Error('不支援的訂單狀態。');
   const {existingQty:existing,company,warehouse}=validateReservationBalance({existingQty,itemReservedQty,aggregateStock,warehouseStock});
   for(const stock of [company,warehouse])if(stock.reserved+stock.transferFreeInTransit>stock.onHand+1e-9)
     throw Error('預留與自由調撥途中量超過實貨，請先核對庫存。');
   if(nextStatus==='cancelled')return {reservedQty:0,shortageQty:0,reservedDelta:existing?-existing:0};
   const requested=legacyReservationQty(requestedQty),incoming=legacyReservationQty(inTransitQty);
   const availableQty=Math.min(inventory.normalizeStock(company).available,inventory.normalizeStock(warehouse).available);
   const plan=planReservation({requestedQty:requested,existingQty:existing,sameStock:true,availableQty,inTransitQty:incoming});
   return {reservedQty:plan.reservedQty,shortageQty:plan.shortageQty,reservedDelta:plan.reservedQty-existing};
 }
 function planMainTransferHold({qty,release=false,aggregateStock,warehouseStock}={}){
   const quantity=legacyReservationQty(qty);
   if(quantity<=0)throw Error('調回保留數量必須大於 0。');
   const project=data=>{
     if(!data)throw Error('公司或分倉庫存不存在。');
     const before={onHand:legacyReservationQty(data.onHand),reserved:legacyReservationQty(data.reserved),
       transferReserved:legacyReservationQty(data.transferReserved),
       transferFreeInTransit:legacyReservationQty(data.transferFreeInTransit)};
     if(before.transferReserved>before.reserved||before.reserved>before.onHand)
       throw Error('備貨保留庫存數量不一致，請先核對資料。');
     if(release){
       if(before.reserved<quantity||before.transferReserved<quantity)
         throw Error('備貨保留庫存數量不一致，不能縮減釋放量。');
     }else if(inventory.normalizeStock(before).available<quantity)
       throw Error('公司或分倉可用庫存不足，請勿調用已預留或調撥途中的貨品。');
     const delta=release?-quantity:quantity;
     return {reserved:legacyReservationQty(before.reserved+delta),
       transferReserved:legacyReservationQty(before.transferReserved+delta)};
   };
   return {aggregate:project(aggregateStock),warehouse:project(warehouseStock)};
 }
 // Compare two complete snapshots, never partial update payloads. This is a
 // stock projection, not permission to move stock or complete a transfer.
 function reservationStockDeltas(before={},after={}){
   const project=record=>{
     if(record.locationSchemaVersion===2){
       if(Object.hasOwn(record,'allocations')||Object.hasOwn(record,'warehouseAllocations'))
         throw Error('多倉預留同時含不同位置格式，請先核對資料。');
       return reservationLocations(record);
     }
     if(['locationSchemaVersion','locations','allocations','warehouseAllocations'].some(key=>Object.hasOwn(record,key)))
       throw Error('不支援的預留位置格式，不可當成單倉計算。');
     // Legacy operations already allow fractional quantities and custody stock.
     // Preserve those semantics; the proposed v2 ledger stays integer-only.
     const qty=legacyReservationQty(record.quantity);
     return qty>0?[{warehouseId:locationId(record.warehouseId),qty}]:[];
   };
   if(before.productKey&&after.productKey&&before.productKey!==after.productKey)
     throw Error('預留產品不一致，不可計算跨產品庫存差額。');
   const previous=project(before),next=project(after);
   const oldQty=new Map(previous.map(row=>[row.warehouseId,row.qty]));
   const newQty=new Map(next.map(row=>[row.warehouseId,row.qty]));
   const warehouseDeltas=[...new Set([...oldQty.keys(),...newQty.keys()])].sort().map(warehouseId=>({
     warehouseId,reservedDelta:(newQty.get(warehouseId)||0)-(oldQty.get(warehouseId)||0)
   })).filter(row=>row.reservedDelta!==0);
   return {companyReservedDelta:next.reduce((sum,row)=>sum+row.qty,0)-previous.reduce((sum,row)=>sum+row.qty,0),warehouseDeltas};
 }
 // Returns a proposed atomic change, never writes Firestore. The caller must
 // re-read all sources inside the SAME transaction before applying any deltas.
 // No relocation: existing quantities stay in their warehouse; a disabled
 // physical location may be released, but cannot receive additional holds.
 function planLocationReservation({productKey,warehouses=[],stocks={},aggregateStock,reservation={},
   requestedQty=0,inTransitQty=0,currentWarehouseId='',nextStatus='normal',itemReservedQty=reservation.quantity}={}){
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
   if(!['normal','cancelled'].includes(nextStatus))throw Error('不支援的訂單狀態。');
   // Validate the complete source format even when cancellation will empty it.
   reservationStockDeltas(reservation,reservation);
   const before=reservationLocations(reservation),existingQty=locationQty(reservation.quantity);
   if(locationQty(itemReservedQty)!==existingQty)
     throw Error('訂單與庫存預留數量不一致，請先核對資料。');
   const requested=nextStatus==='cancelled'?0:locationQty(requestedQty);
   const incoming=nextStatus==='cancelled'?0:locationQty(inTransitQty);
   const validateStock=(data,ownQty)=>{
     const numbers={onHand:locationQty(data.onHand),reserved:locationQty(data.reserved),
       transferFreeInTransit:locationQty(data.transferFreeInTransit)};
     if(numbers.reserved<ownQty||numbers.reserved+numbers.transferFreeInTransit>numbers.onHand)
       throw Error('公司或分倉預留與調撥途中量不一致，請先稽核。');
   };
   validateStock(aggregateStock,existingQty);
   for(const w of warehouses){
     const ownQty=before.find(row=>row.warehouseId===w.id)?.qty||0;
     if(stocks[w.id]&&(physicalWarehouse(w)||ownQty>0))validateStock(stocks[w.id],ownQty);
   }
   const kept=new Map();
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
   const next={locationSchemaVersion:2,locations:ledger.locations,quantity,shortageQty:ledger.shortageQty,
     status:nextStatus==='cancelled'?'released':quantity>0?'active':ledger.shortageQty>0?'shortage':'fulfilled'};
   const changes=reservationStockDeltas(reservation,next);
   return {reservation:next,warehouseDeltas:changes.warehouseDeltas,
     companyReservedDelta:changes.companyReservedDelta,
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
 return {orderTransferReservationSource,orderTransferReservationSources,planOrderTransferTarget,planReservationReceipt,planReservationReturn,planReservationIssue,validateReservationBalance,physicalWarehouse,planMainTransferHold,planReservationLifecycle,reservationStockDeltas,validateMultiLocationLedger,planLocationReservation,reservationLocations,planMultiWarehouseReservation,planReservation,planShortageAllocation,allocateReceiptToShortages,reservationLocationCanChange,selectSingleWarehouse,compareReservationPriority};
});
