'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const workflow=require('../modules/workflow-core'),service=require('../modules/service-work-core');
const item={orderId:'O',itemId:'S',productId:'P',productType:'SERVICE',serviceKind:'BIOPLEX_LAB',qty:2};
function record(kind,caseId,serviceQty,completed=true){
 const events=service.STEPS[kind].map((type,index)=>({id:caseId+'-'+index,type,actorUid:'U',
  occurredAt:new Date(Date.UTC(2026,9,23,9,index)).toISOString(),partyName:'委外單位',
  receivedBy:'客戶',reportRef:'REPORT-1',deliveryRef:'DELIVERY-1',workSummary:'維修完成'}));
 return {orderId:'O',itemId:'S',productId:'P',caseId,serviceQty,kind,
  events:completed?events:events.slice(0,-1)};
}
for(const kind of Object.keys(service.STEPS))test(kind+' uses registered completion evidence without physical delivery',()=>{
 const source={...item,serviceKind:kind};
 const partial=workflow.projectItem(source,[record(kind,'A',1),record(kind,'B',1,false)]);
 assert.equal(partial.workCategory,'delivery');assert.equal(partial.outstandingQty,1);
 assert.equal(partial.serviceProgress.completedQty,1);assert.equal(partial.effectiveDeliveredQty,0);
 const cases=[record(kind,'A',1),record(kind,'B',1)];
 const done=workflow.projectItem(source,cases);
 assert.equal(done.workCategory,'billing');assert.equal(done.outstandingQty,0);
 assert.equal(done.effectiveDeliveredQty,0);assert.equal(done.requiredSupplyQty,0);
 assert.equal(workflow.projectItem({...source,isBilled:true},cases).workCategory,'complete');
 assert.equal(workflow.projectItem({...source,lifecycleStatus:'cancelled'},cases).workCategory,'closed');
 assert.equal(workflow.projectItem({...source,isBilled:true},[record(kind,'A',1)]).workCategory,'delivery');
});
test('untrusted item quantities and delivery flags cannot supply service completion evidence',()=>{
 const input={...item,deliveredQty:2,effectiveDeliveredQty:2,isBilled:true,
  serviceProgress:{completedQty:2},serviceCases:[record('BIOPLEX_LAB','A',2)]};
 assert.equal(workflow.projectItem(input).workCategory,'delivery');
 assert.equal(workflow.projectItem(input,[]).workCategory,'delivery');
 assert.equal(workflow.projectItem(input,[]).serviceProgress.completedQty,0);
});
test('service evidence must match the exact order, item, product, kind and commercial limit',()=>{
 const saved=record('BIOPLEX_LAB','A',2);
 for(const patch of [{orderId:'OTHER'},{itemId:'OTHER'},{productId:'OTHER'},{kind:'ONSITE_REPAIR'},{serviceQty:3}])
  assert.throws(()=>workflow.projectItem(item,[{...saved,...patch}]));
 assert.throws(()=>workflow.projectItem({...item,orderId:''},[]),/識別碼/);
 assert.throws(()=>workflow.projectItem({...item,productType:'Goods'},[saved]),/Service/);
 assert.throws(()=>workflow.projectItem(item,[saved,saved]),/重複/);
});
test('mixed-order goods keep their original workflow while service completion stays separate',()=>{
 const goods={productType:'Goods',qty:2,reservedQty:2,deliveredQty:0};
 const serviceDone=workflow.projectItem(item,[record('BIOPLEX_LAB','A',2)]);
 assert.equal(serviceDone.workCategory,'billing');
 assert.equal(workflow.projectItem(goods).workCategory,'delivery');
 assert.equal(workflow.projectItem({...goods,deliveredQty:2}).workCategory,'billing');
 assert.equal(workflow.projectItem(goods).serviceProgress,undefined);
});
test('fractional commercial quantities close without a phantom remainder from floating point',()=>{
 const cases=[record('BIOPLEX_LAB','A',0.1),record('BIOPLEX_LAB','B',0.7)];
 const result=workflow.projectItem({...item,qty:0.8},cases);
 assert.equal(result.serviceProgress.completedQty,0.8);assert.equal(result.outstandingQty,0);
 assert.equal(result.workCategory,'billing');
 assert.throws(()=>workflow.projectItem({...item,qty:1e-12},[record('BIOPLEX_LAB','tiny',2e-12)]),/超過/);
});
