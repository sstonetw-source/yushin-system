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

  function dateOnly(value){
    const time=timeOf(value);
    if(time===null)return '';
    return new Date(time).toISOString().slice(0,10);
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
    const terminal=['CANCELLED','CLOSED'].includes(x.status);
    const effectiveOrderedQty=terminal?x.receivedQty:x.qty;
    const receivedQty=Math.min(effectiveOrderedQty,x.receivedQty);
    const incomingQty=terminal?0:x.remainingQty;
    const incomingAmount=incomingQty*unitCost;
    const isStockReplenishment=x.sourceType===supply.SOURCES.STOCK_REPLENISHMENT;
    const sourceLabel=isStockReplenishment?'備庫採購':'客戶訂單採購';
    const documentKey=String(x.purchaseDocumentId||x.purchaseDocumentNo||x.internalNo||x.id||'').trim();
    const supplierName=String(x.supplier||x.supplierName||'未指定供應商').trim()||'未指定供應商';
    const supplierId=String(x.supplierId||'').trim();
    const supplierKey=supplierId?('id:'+supplierId):('name:'+supplierName.normalize('NFKC').toLocaleLowerCase());

    const brand=String(x.brand||'未指定廠牌').trim()||'未指定廠牌';
    const date=String(x.orderDate||x.createdAt||'').slice(0,10);
    const month=/^\d{4}-\d{2}/.test(date)?date.slice(0,7):'未指定月份';
    const completionAt=!terminal&&effectiveOrderedQty>0
      ? completionReceiptAt(receipts,effectiveOrderedQty)
      : '';
    const leadTimeDays=completionAt?dayDiff(x.orderDate||x.createdAt,completionAt):null;
    const expectedDate=String(x.expectedDate||x.scheduleDate||'').slice(0,10);
    const completionDate=String(completionAt||'').slice(0,10);
    const onTime=expectedDate&&completionDate ? completionDate<=expectedDate : null;
    const agingAt=nowValue||new Date().toISOString();
    const agingDate=dateOnly(agingAt);
    const openAgeDays=incomingQty>0?dayDiff(x.orderDate||x.createdAt,agingAt):null;
    const late=!!(incomingQty>0&&expectedDate&&agingDate&&agingDate>expectedDate);
    const lateDays=late?dayDiff(expectedDate,agingDate):0;
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
      sourceLabel,
      unitCost,
      effectiveOrderedQty,
      receivedQty,
      incomingQty,
      orderedAmount:effectiveOrderedQty*unitCost,
      receivedAmount:receivedQty*unitCost,
      incomingAmount,
      stockAmount:isStockReplenishment?effectiveOrderedQty*unitCost:0,
      customerOrderAmount:isStockReplenishment?0:effectiveOrderedQty*unitCost,
      missingUnitCost:effectiveOrderedQty>0&&unitCost<=0,
      completionAt,
      leadTimeDays,
      expectedDate,
      onTime,
      openAgeDays,
      late,
      lateDays,
      lateAmount:late?incomingAmount:0,
      isStockReplenishment
    };
  }

  function newMetric(){
    return {
      documents:new Set(),
      lineCount:0,
      orderedQty:0,
      receivedQty:0,
      incomingQty:0,
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
      maxOpenAgeDays:0,
      lateDocuments:new Set(),
      lateLineCount:0,
      lateAmount:0,
      lateDaysTotal:0,
      maxLateDays:0
    };
  }

  function addMetric(metric,row){
    if(row.documentKey)metric.documents.add(row.documentKey);
    metric.lineCount++;
    metric.orderedQty+=row.effectiveOrderedQty;
    metric.receivedQty+=row.receivedQty;
    metric.incomingQty+=row.incomingQty;
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
    if(row.late){
      if(row.documentKey)metric.lateDocuments.add(row.documentKey);
      metric.lateLineCount++;
      metric.lateAmount+=row.lateAmount;
      if(Number.isFinite(row.lateDays)){
        metric.lateDaysTotal+=row.lateDays;
        metric.maxLateDays=Math.max(metric.maxLateDays,row.lateDays);
      }
    }
  }

  function finalizeMetric(metric){
    return {
      documentCount:metric.documents.size,
      lineCount:metric.lineCount,
      orderedQty:metric.orderedQty,
      receivedQty:metric.receivedQty,
      incomingQty:metric.incomingQty,
      serviceLevel:metric.orderedQty?(metric.receivedQty/metric.orderedQty)*100:null,
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
      maxOpenAgeDays:metric.openAgeCount?metric.maxOpenAgeDays:null,
      lateDocumentCount:metric.lateDocuments.size,
      lateLineCount:metric.lateLineCount,
      lateAmount:metric.lateAmount,
      avgLateDays:metric.lateLineCount?metric.lateDaysTotal/metric.lateLineCount:null,
      maxLateDays:metric.lateLineCount?metric.maxLateDays:null
    };
  }

  const AGING_BUCKETS=Object.freeze([
    {key:'0_7',label:'0–7 天',minDays:0,maxDays:7},
    {key:'8_14',label:'8–14 天',minDays:8,maxDays:14},
    {key:'15_30',label:'15–30 天',minDays:15,maxDays:30},
    {key:'31_plus',label:'31+ 天',minDays:31,maxDays:null}
  ]);

  function agingBucketForDays(days){
    if(!Number.isFinite(days)||days<0)return null;
    if(days<8)return AGING_BUCKETS[0];
    if(days<15)return AGING_BUCKETS[1];
    if(days<31)return AGING_BUCKETS[2];
    return AGING_BUCKETS[3];
  }

  function buildAgingBuckets(rows=[]){
    const buckets=new Map(AGING_BUCKETS.map(bucket=>[bucket.key,{
      ...bucket,
      documents:new Set(),
      lineCount:0,
      incomingQty:0,
      incomingAmount:0,
      lateLineCount:0,
      lateAmount:0,
      maxOpenAgeDays:0
    }]));
    for(const row of rows||[]){
      if(!(n(row?.incomingQty)>0)||!Number.isFinite(row?.openAgeDays))continue;
      const definition=agingBucketForDays(row.openAgeDays);
      if(!definition)continue;
      const bucket=buckets.get(definition.key);
      if(row.documentKey)bucket.documents.add(row.documentKey);
      bucket.lineCount++;
      bucket.incomingQty+=n(row.incomingQty);
      bucket.incomingAmount+=n(row.incomingAmount);
      bucket.maxOpenAgeDays=Math.max(bucket.maxOpenAgeDays,Number(row.openAgeDays)||0);
      if(row.late){
        bucket.lateLineCount++;
        bucket.lateAmount+=n(row.lateAmount);
      }
    }
    return AGING_BUCKETS.map(definition=>{
      const bucket=buckets.get(definition.key);
      return {
        key:bucket.key,
        label:bucket.label,
        minDays:bucket.minDays,
        maxDays:bucket.maxDays,
        documentCount:bucket.documents.size,
        lineCount:bucket.lineCount,
        incomingQty:bucket.incomingQty,
        incomingAmount:bucket.incomingAmount,
        lateLineCount:bucket.lateLineCount,
        lateAmount:bucket.lateAmount,
        maxOpenAgeDays:bucket.lineCount?bucket.maxOpenAgeDays:null
      };
    });
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
      bySource:grouped(rows,row=>row.sourceLabel,'source'),
      byBrand:grouped(rows,row=>row.brand,'brand'),
      byMonth:grouped(rows,row=>row.month,'month','month'),
      agingBuckets:buildAgingBuckets(rows)
    };
  }

  return {AGING_BUCKETS,agingBucketForDays,buildAgingBuckets,projectSupply,summarize};
});