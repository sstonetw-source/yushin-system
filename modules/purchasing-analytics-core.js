(function(root,factory){
  const supply=typeof module==='object'&&module.exports?require('./supply-core.js'):(root&&root.YushinSupply);
  const api=factory(supply);
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.YushinPurchasingAnalytics=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(supply){
  function n(value){
    const number=Number(value);
    return Number.isFinite(number)?Math.max(0,number):0;
  }

  function timeOf(value){
    const time=Date.parse(String(value||''));
    return Number.isFinite(time)?time:null;
  }

  function dayDiff(start,end){
    const a=timeOf(start),b=timeOf(end);
    return a===null||b===null?null:Math.max(0,(b-a)/86400000);
  }

  function receiptsBySupply(records=[]){
    const map=new Map();
    for(const receipt of records||[]){
      const key=String(receipt?.supplyOrderId||'').trim();
      if(!key)continue;
      if(!map.has(key))map.set(key,[]);
      map.get(key).push(receipt);
    }
    for(const rows of map.values()){
      rows.sort((a,b)=>String(a.createdAt||a.receiptDate||'').localeCompare(String(b.createdAt||b.receiptDate||'')));
    }
    return map;
  }

  function completionReceiptAt(receipts=[],targetQty=0){
    const target=n(targetQty);
    if(!(target>0))return '';
    let total=0;
    for(const receipt of receipts){
      total+=n(receipt?.qty);
      if(total>=target)return String(receipt?.receiptDate||receipt?.createdAt||'');
    }
    return '';
  }

  function projectSupply(record={},receipts=[],nowValue=''){
    if(!supply)throw new Error('Supply core is required.');
    const x=supply.normalize(record);
    const unitCost=n(x.unitCost);
    const cancelled=x.status==='CANCELLED';
    const effectiveOrderedQty=cancelled?x.receivedQty:x.qty;
    const receivedQty=Math.min(effectiveOrderedQty,x.receivedQty);
    const incomingQty=cancelled?0:x.remainingQty;
    const isStockReplenishment=x.sourceType===supply.SOURCES.STOCK_REPLENISHMENT;
    const documentKey=String(x.purchaseDocumentId||x.purchaseDocumentNo||x.internalNo||x.id||'').trim();
    const supplierName=String(x.supplier||x.supplierName||'未指定供應商').trim()||'未指定供應商';
    const supplierId=String(x.supplierId||'').trim();
    const supplierKey=supplierId?('id:'+supplierId):('name:'+supplierName.normalize('NFKC').toLocaleLowerCase());

    const brand=String(x.brand||'未指定廠牌').trim()||'未指定廠牌';
    const date=String(x.orderDate||x.createdAt||'').slice(0,10);
    const month=/^\d{4}-\d{2}/.test(date)?date.slice(0,7):'未指定月份';
    const completionAt=!cancelled&&effectiveOrderedQty>0
      ? completionReceiptAt(receipts,effectiveOrderedQty)
      : '';
    const leadTimeDays=completionAt?dayDiff(x.orderDate||x.createdAt,completionAt):null;
    const expectedDate=String(x.expectedDate||x.scheduleDate||'').slice(0,10);
    const completionDate=String(completionAt||'').slice(0,10);
    const onTime=expectedDate&&completionDate ? completionDate<=expectedDate : null;
    const agingAt=nowValue||new Date().toISOString();
    const openAgeDays=incomingQty>0?dayDiff(x.orderDate||x.createdAt,agingAt):null;
    return {
      record:x,
      supplier:supplierName,
      supplierKey,
      brand,
      date,
      month,
      documentKey,
      method:x.method,
      sourceType:x.sourceType,
      unitCost,
      effectiveOrderedQty,
      receivedQty,
      incomingQty,
      orderedAmount:effectiveOrderedQty*unitCost,
      receivedAmount:receivedQty*unitCost,
      incomingAmount:incomingQty*unitCost,
      stockAmount:isStockReplenishment?effectiveOrderedQty*unitCost:0,
      customerOrderAmount:isStockReplenishment?0:effectiveOrderedQty*unitCost,
      missingUnitCost:effectiveOrderedQty>0&&unitCost<=0,
      completionAt,
      leadTimeDays,
      expectedDate,
      onTime,
      openAgeDays,
      isStockReplenishment
    };
  }

  function newMetric(){
    return {
      documents:new Set(),
      lineCount:0,
      orderedAmount:0,
      receivedAmount:0,
      incomingAmount:0,
      stockAmount:0,
      customerOrderAmount:0,
      missingUnitCostCount:0,
      leadTimeDaysTotal:0,
      leadTimeCount:0,
      onTimeCount:0,
      onTimeEligibleCount:0,
      openAgeDaysTotal:0,
      openAgeCount:0,
      maxOpenAgeDays:0
    };
  }

  function addMetric(metric,row){
    if(row.documentKey)metric.documents.add(row.documentKey);
    metric.lineCount++;
    metric.orderedAmount+=row.orderedAmount;
    metric.receivedAmount+=row.receivedAmount;
    metric.incomingAmount+=row.incomingAmount;
    metric.stockAmount+=row.stockAmount;
    metric.customerOrderAmount+=row.customerOrderAmount;
    if(row.missingUnitCost)metric.missingUnitCostCount++;
    if(Number.isFinite(row.leadTimeDays)){
      metric.leadTimeDaysTotal+=row.leadTimeDays;
      metric.leadTimeCount++;
    }
    if(row.onTime!==null){
      metric.onTimeEligibleCount++;
      if(row.onTime)metric.onTimeCount++;
    }
    if(Number.isFinite(row.openAgeDays)){
      metric.openAgeDaysTotal+=row.openAgeDays;
      metric.openAgeCount++;
      metric.maxOpenAgeDays=Math.max(metric.maxOpenAgeDays,row.openAgeDays);
    }
  }

  function finalizeMetric(metric){
    return {
      documentCount:metric.documents.size,
      lineCount:metric.lineCount,
      orderedAmount:metric.orderedAmount,
      receivedAmount:metric.receivedAmount,
      incomingAmount:metric.incomingAmount,
      stockAmount:metric.stockAmount,
      customerOrderAmount:metric.customerOrderAmount,
      missingUnitCostCount:metric.missingUnitCostCount,
      leadTimeCount:metric.leadTimeCount,
      avgLeadTimeDays:metric.leadTimeCount?metric.leadTimeDaysTotal/metric.leadTimeCount:null,
      onTimeCount:metric.onTimeCount,
      onTimeEligibleCount:metric.onTimeEligibleCount,
      onTimeRate:metric.onTimeEligibleCount?(metric.onTimeCount/metric.onTimeEligibleCount)*100:null,
      openAgeCount:metric.openAgeCount,
      avgOpenAgeDays:metric.openAgeCount?metric.openAgeDaysTotal/metric.openAgeCount:null,
      maxOpenAgeDays:metric.openAgeCount?metric.maxOpenAgeDays:null
    };
  }

  function grouped(rows,keyOf,labelKey,sortMode='amount'){
    const groups=new Map();
    for(const row of rows){
      const key=String(keyOf(row)||'未指定').trim()||'未指定';
      if(!groups.has(key))groups.set(key,newMetric());
      addMetric(groups.get(key),row);
    }
    const result=[...groups.entries()].map(([name,metric])=>({[labelKey]:name,...finalizeMetric(metric)}));
    if(sortMode==='month')return result.sort((a,b)=>String(b[labelKey]).localeCompare(String(a[labelKey])));
    return result.sort((a,b)=>b.orderedAmount-a.orderedAmount||String(a[labelKey]).localeCompare(String(b[labelKey]),'zh-Hant'));
  }

  function summarize(records=[],receiptRecords=[],options={}){
    const receiptMap=receiptsBySupply(receiptRecords);
    const nowValue=options.now||new Date().toISOString();
    const rows=(records||[]).map(record=>projectSupply(record,receiptMap.get(String(record?.id||''))||[],nowValue))
      .filter(row=>row.effectiveOrderedQty>0||row.receivedQty>0);
    const totalMetric=newMetric();
    rows.forEach(row=>addMetric(totalMetric,row));
    const bySupplier=grouped(rows,row=>row.supplierKey,'supplierKey').map(group=>{
      const sample=rows.find(row=>row.supplierKey===group.supplierKey);
      return {...group,supplier:sample?.supplier||group.supplierKey};
    });
    return {
      rows,
      totals:finalizeMetric(totalMetric),
      bySupplier,
      byBrand:grouped(rows,row=>row.brand,'brand'),
      byMonth:grouped(rows,row=>row.month,'month','month')
    };
  }

  return {projectSupply,summarize};
});