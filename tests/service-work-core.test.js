'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const core=require('../modules/service-work-core.js');
const at=index=>new Date(Date.UTC(2026,9,22,9,index)).toISOString();
const base=(kind,caseId='C')=>({orderId:'O',itemId:'S',caseId,kind,events:[]});
const event=(id,type,i=0,extra={})=>({id,type,occurredAt:at(i),actorUid:'U',...extra});
const scenarios=[
  {
    kind:'BIOPLEX_LAB',steps:[
      event('s','SAMPLE_RECEIVED',0),
      event('x','EXPERIMENT_COMPLETED',1),
      event('r','REPORT_SENT',2,{reportRef:'report/R-1'})
    ],finalCustody:'IN_HOUSE'
  },
  {
    kind:'PIPETTE_CALIBRATION',steps:[
      event('d','DEVICE_RECEIVED',0),
      event('v','VENDOR_SENT',1,{partyName:'Outside Calibrator'}),
      event('b','VENDOR_RETURNED',2),
      event('c','CUSTOMER_RETURNED',3,{receivedBy:'Customer A'})
    ],finalCustody:'RETURNED_TO_CUSTOMER'
  },
  {
    kind:'TISSUE_SLICING',steps:[
      event('s','SAMPLE_RECEIVED',0),
      event('v','VENDOR_SENT',1,{partyName:'Histology vendor'}),
      event('b','VENDOR_RETURNED',2),
      event('c','CUSTOMER_DELIVERED',3,{deliveryRef:'proof/T-1'})
    ],finalCustody:'IN_HOUSE'
  },
  {
    kind:'ONSITE_REPAIR',steps:[
      event('r','REPAIR_COMPLETED',0,{workSummary:'Replaced faulty power switch'})
    ],finalCustody:'CUSTOMER_SITE'
  }
];
for(const scenario of scenarios){
  test(scenario.kind+' follows the real service workflow and closes on its own evidence',()=>{
    let record=base(scenario.kind),projection=core.projectServiceCase(record);
    assert.equal(projection.status,'PENDING');
    for(let i=0;i<scenario.steps.length;i++){
      const result=core.applyServiceEvent(record,scenario.steps[i]);
      assert.equal(result.status,'committed');
      record=result.record;projection=result.projection;
      assert.equal(projection.completed,i===scenario.steps.length-1);
      assert.equal(projection.nextEvent,scenario.steps[i+1]?.type||null);
      assert.equal(projection.events.length,i+1);
      assert.equal(projection.status,i===scenario.steps.length-1?'COMPLETED':'IN_PROGRESS');
      assert.deepEqual(Object.keys(record).sort(),['caseId','events','itemId','kind','orderId'].sort());
    }
    assert.equal(projection.custody,scenario.finalCustody);
    assert.equal(projection.completedAt,scenario.steps.at(-1).occurredAt);
    // Same immutable event must replay without another completion or stock mutation.
    const replay=core.applyServiceEvent(record,scenario.steps.at(-1));
    assert.equal(replay.status,'already-applied');
    assert.deepEqual(replay.record,record);
    assert.throws(()=>core.applyServiceEvent(record,{...scenario.steps[0],id:'extra',occurredAt:at(9)}),/服務動作/);
  });
}
test('Pipette and tissue cases cannot claim vendor return before sending out',()=>{
  for(const kind of ['PIPETTE_CALIBRATION','TISSUE_SLICING']){
    const before=base(kind);
    assert.throws(()=>core.applyServiceEvent(before,event('x','VENDOR_RETURNED')),/服務動作/);
    const first=core.applyServiceEvent(before,event('a',kind==='PIPETTE_CALIBRATION'?'DEVICE_RECEIVED':'SAMPLE_RECEIVED')).record;
    assert.throws(()=>core.applyServiceEvent(first,event('x','VENDOR_RETURNED',1)),/服務動作/);
  }
});
test('Report, third-party custody, calibration handoff, and repair require actual evidence',()=>{
  assert.throws(()=>core.normalizedEvent(event('v','VENDOR_SENT',0)),/收件單位/);
  assert.throws(()=>core.normalizedEvent(event('x','REPORT_SENT',0)),/報告憑證/);
  assert.throws(()=>core.normalizedEvent(event('x','CUSTOMER_DELIVERED',0)),/交付憑證/);
  assert.throws(()=>core.normalizedEvent(event('x','CUSTOMER_RETURNED',0)),/領收人/);
  assert.throws(()=>core.normalizedEvent(event('x','REPAIR_COMPLETED',0)),/維修內容/);
});
test('Operation IDs are idempotent but cannot be reused for changed intent',()=>{
  const first=core.applyServiceEvent(base('BIOPLEX_LAB'),event('fixed','SAMPLE_RECEIVED'));
  assert.equal(core.applyServiceEvent(first.record,event('fixed','SAMPLE_RECEIVED')).status,'already-applied');
  assert.throws(()=>core.applyServiceEvent(first.record,event('fixed','SAMPLE_RECEIVED',0,{notes:'different'})),/不同內容/);
  assert.throws(()=>core.projectServiceCase({...first.record,events:[...first.record.events,first.record.events[0]]}),/識別碼重複/);
});
test('Backdated or forged extra service events reject without projecting completion',()=>{
  const record=base('PIPETTE_CALIBRATION');
  assert.throws(()=>core.applyServiceEvent(record,event('a','DEVICE_RECEIVED',0,{qty:6})),/未授權欄位/);
  assert.throws(()=>core.applyServiceEvent(record,event('a','DEVICE_RECEIVED',0,{occurredAt:'2026-10-22'})),/時區/);
  assert.throws(()=>core.projectServiceCase({...record,events:[event('a','DEVICE_RECEIVED',2),event('b','VENDOR_SENT',1,{partyName:'V'})]}),/早於/);
  assert.throws(()=>core.projectServiceCase({...record,kind:'UNKNOWN'}),/不支援/);
});
test('Bio-Plex cases stay separate from pooled reagent stock and repair material use',()=>{
  const caseA=core.applyServiceEvent(base('BIOPLEX_LAB','sample-A'),event('a','SAMPLE_RECEIVED')).record;
  const caseB=core.applyServiceEvent(base('BIOPLEX_LAB','sample-B'),event('b','SAMPLE_RECEIVED')).record;
  assert.equal(core.projectServiceCase(caseA).custody,'IN_HOUSE');
  assert.equal(core.projectServiceCase(caseB).custody,'IN_HOUSE');
  assert.equal(caseA.events.length,1);assert.equal(caseB.events.length,1);
  // Materials are neither fabricated from service qty nor debited by this core.
  assert.equal('stockQty' in core.projectServiceCase(caseA),false);
  assert.equal('supplyOrderId' in core.projectServiceCase(caseA),false);
  assert.equal('inventoryLots' in caseA,false);
  assert.equal(core.projectServiceCase(base('ONSITE_REPAIR')).nextEvent,'REPAIR_COMPLETED');
});

test('service timestamps reject impossible calendar dates rather than normalizing them',()=>{
  for(const impossible of ['2026-02-30T12:00:00Z','2026-04-31T01:30:00+08:00',
    '2026-13-01T00:00:00Z','2026-10-22T24:00:00Z']){
    assert.throws(()=>core.normalizedEvent({
      ...event('bad-date','SAMPLE_RECEIVED'),occurredAt:impossible
    }),/有效日期/);
  }
  assert.equal(core.normalizedEvent({
    ...event('leap','SAMPLE_RECEIVED'),occurredAt:'2028-02-29T08:00:00+08:00'
  }).occurredAt,'2028-02-29T08:00:00+08:00');
});

test('commercial service quantity projects partial work without using specimen counts or stock',()=>{
  const item={itemId:'S',productId:'P',productType:'SERVICE',serviceKind:'BIOPLEX_LAB',qty:3};
  let done={...base('BIOPLEX_LAB','A'),productId:'P',serviceQty:2};
  for(const step of scenarios[0].steps)done=core.applyServiceEvent(done,step).record;
  const pending={...base('BIOPLEX_LAB','B'),productId:'P',serviceQty:1};
  assert.deepEqual(core.projectServiceItem(item,[done,pending]),{
    orderedQty:3,allocatedQty:3,completedQty:2,unassignedQty:0,inProgressQty:1,remainingQty:1,caseCount:2
  });
  assert.throws(()=>core.projectServiceItem({...item,qty:2},[done,pending]),/超過訂單數量/);
  assert.throws(()=>core.projectServiceItem(item,[done,done]),/重複/);
  assert.throws(()=>core.projectServiceItem(item,[{...done,productId:'Q'}]),/來源/);
});
test('service quantity validates numbers, fractional totals and sub-nanounit over-allocation',()=>{
  for(const value of [undefined,null,true,'1',0,-1,NaN,Infinity,Number.MAX_VALUE])
    assert.throws(()=>core.serviceQuantity(value),/有效的正數/);
  const item={itemId:'S',productId:'P',productType:'SERVICE',qty:0.3};
  const record=qty=>({...base('BIOPLEX_LAB'),productId:'P',serviceQty:qty});
  assert.equal(core.projectServiceItem(item,[record(0.1),{...record(0.2),caseId:'D'}]).unassignedQty,0);
  assert.throws(()=>core.projectServiceItem({...item,qty:1e-12},[record(2e-12)]),/超過/);
  assert.throws(()=>core.projectServiceItem({...item,qty:1e15},[record(1e15+0.5)]),/超過/);
  assert.throws(()=>core.projectServiceItem(item,Array(core.MAX_ITEM_CASES+1).fill(record(1))),/上限/);
});
