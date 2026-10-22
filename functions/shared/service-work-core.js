(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.YushinServiceWork=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  // One case represents one piece of customer equipment, sample, or service job.
  // A sales line can be linked to multiple cases: quantity is not inferred here.
  // Materials and outside-vendor bills use their own purchasing/stock ledgers.
  const STEPS=Object.freeze({
    BIOPLEX_LAB:Object.freeze(['SAMPLE_RECEIVED','EXPERIMENT_COMPLETED','REPORT_SENT']),
    PIPETTE_CALIBRATION:Object.freeze(['DEVICE_RECEIVED','VENDOR_SENT','VENDOR_RETURNED','CUSTOMER_RETURNED']),
    TISSUE_SLICING:Object.freeze(['SAMPLE_RECEIVED','VENDOR_SENT','VENDOR_RETURNED','CUSTOMER_DELIVERED']),
    ONSITE_REPAIR:Object.freeze(['REPAIR_COMPLETED'])
  });
  const VALID_FIELDS=new Set(['id','type','occurredAt','actorUid','notes',
    'partyName','receivedBy','reportRef','deliveryRef','workSummary']);

  function fault(message){throw Error(message);}
  function identifier(value,label){
    if(typeof value!=='string'||!value||value!==value.trim()||value.includes('/')||value.length>160)
      fault(label+'識別碼不正確。');
    return value;
  }
  function timestamp(value){
    const parts=typeof value==='string'
      ? /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.exec(value)
      : null;
    if(!parts||!Number.isFinite(Date.parse(value)))fault('服務事件時間必須包含有效日期與時區。');
    // Date.parse silently normalizes e.g. February 30 to March 2; reject it.
    const year=Number(parts[1]),month=Number(parts[2]),day=Number(parts[3]);
    const leap=year%4===0&&(year%100!==0||year%400===0);
    const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
    if(month<1||month>12||day<1||day>days[month-1]
      ||Number(parts[4])>23||Number(parts[5])>59||Number(parts[6])>59)
      fault('服務事件時間必須包含有效日期與時區。');
    return value;
  }
  function normalizedEvent(raw){
    if(!raw||typeof raw!=='object'||Array.isArray(raw)
      ||Object.keys(raw).some(key=>!VALID_FIELDS.has(key)))fault('服務事件含未授權欄位。');
    const data={
      id:identifier(raw.id,'服務事件'),
      type:identifier(raw.type,'服務動作'),
      occurredAt:timestamp(raw.occurredAt),
      actorUid:identifier(raw.actorUid,'操作人員')
    };
    for(const key of ['notes','partyName','receivedBy','reportRef','deliveryRef','workSummary']){
      const value=raw[key];
      if(value!==undefined){
        if(typeof value!=='string'||value.length>1000)fault('服務事件文字資料不正確。');
        if(value)data[key]=value.trim();
      }
    }
    if(['VENDOR_SENT'].includes(data.type)&&!data.partyName)fault('委外寄送必須留下收件單位。');
    if(['CUSTOMER_RETURNED'].includes(data.type)&&!data.receivedBy)fault('客戶器材交還必須留下領收人。');
    if(data.type==='REPORT_SENT'&&!data.reportRef)fault('交付報告必須留下報告憑證。');
    if(data.type==='CUSTOMER_DELIVERED'&&!data.deliveryRef)fault('切片成果交付必須留下交付憑證。');
    if(data.type==='REPAIR_COMPLETED'&&!data.workSummary)fault('維修完工必須留下維修內容。');
    return data;
  }
  function assertCase(record){
    if(!record||typeof record!=='object'||Array.isArray(record))fault('服務案件格式不正確。');
    identifier(record.orderId,'訂單');identifier(record.itemId,'訂單品項');
    identifier(record.caseId,'服務案件');
    if(!Object.prototype.hasOwnProperty.call(STEPS,record.kind))fault('不支援的服務類型。');
    if(!Array.isArray(record.events)||record.events.length>40)fault('服務事件紀錄數量不正確。');
  }
  function projectServiceCase(record){
    assertCase(record);
    const required=STEPS[record.kind],seen=new Set();
    let lastTimestamp=0;
    const events=record.events.map((entry,index)=>{
      const event=normalizedEvent(entry);
      if(seen.has(event.id))fault('服務事件識別碼重複。');
      seen.add(event.id);
      if(index>=required.length||event.type!==required[index])
        fault('服務事件順序不正確，不能跳過必要的收件、委外、完工或交付。');
      const at=Date.parse(event.occurredAt);
      if(index&&at<lastTimestamp)fault('服務作業日期早於上一個已確認事件。');
      lastTimestamp=at;
      return event;
    });
    const completed=events.length===required.length;
    let custody='NOT_RECEIVED';
    if(record.kind==='BIOPLEX_LAB'){
      // Issuing the report does not prove specimen disposal or physical return.
      custody=events.length?'IN_HOUSE':'NOT_RECEIVED';
    }else if(record.kind==='PIPETTE_CALIBRATION'||record.kind==='TISSUE_SLICING'){
      // Tissue deliverables can be sent while the specimen stays in custody.
      // Only a pipette customer-return event transfers the device physically.
      custody=events.length===0?'NOT_RECEIVED':
        events.length===1?'IN_HOUSE':
        events.length===2?'AT_VENDOR':
        completed&&record.kind==='PIPETTE_CALIBRATION'?'RETURNED_TO_CUSTOMER':'IN_HOUSE';
    }else custody='CUSTOMER_SITE';
    return {
      orderId:record.orderId,itemId:record.itemId,caseId:record.caseId,kind:record.kind,
      status:completed?'COMPLETED':events.length?'IN_PROGRESS':'PENDING',
      completed,nextEvent:required[events.length]||null,
      custody,events,completedAt:completed?events[events.length-1].occurredAt:''
    };
  }
  function applyServiceEvent(record,raw){
    const state=projectServiceCase(record),event=normalizedEvent(raw);
    const old=state.events.find(row=>row.id===event.id);
    if(old){
      // Same operation ID with the same payload is a no-op. Different intent is unsafe.
      const same=Object.keys({...old,...event}).every(key=>old[key]===event[key]);
      if(!same)fault('服務事件識別碼已用於不同內容。');
      return {status:'already-applied',record:{...record,events:state.events},projection:state};
    }
    if(state.completed||event.type!==state.nextEvent)
      fault('服務動作與目前作業進度不符。');
    const projection=projectServiceCase({...record,events:[...state.events,event]});
    return {status:'committed',record:{...record,events:projection.events},projection};
  }
  return {STEPS,normalizedEvent,projectServiceCase,applyServiceEvent};
});
