'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {commitServiceCaseEvent,getServiceCaseStatus,caseDocId}=require('../functions/service-case-service.js');

function fixture({role='sales',ownerUid='U',kind='BIOPLEX_LAB',productType='SERVICE',
  productMasterType='SERVICE',orderStatus='normal',initialized=true,disabled=false,retry=false}={}){
  const clone=x=>x===undefined?undefined:structuredClone(x);
  const docs=new Map([
    ['users/U',{role,active:!disabled,disabled}],
    ['orders/O',{ownerUid,orderStatus,inventoryReservationStatus:initialized?'completed':'pending',
      items:[{itemId:'I',productId:'P',productType,serviceKind:kind,qty:1}]}],
    ['products/P',{active:true,productType:productMasterType,serviceKind:kind}]
  ]);
  const ids=[],written=[];
  const db={collection:name=>({doc:id=>({path:name+'/'+id})}),
    runTransaction:async callback=>{
      const apply=async()=>{
        const writes=[];
        const tx={
          get:async ref=>({exists:docs.has(ref.path),data:()=>clone(docs.get(ref.path))}),
          set:(ref,value)=>writes.push([ref.path,clone(value)])
        };
        const value=await callback(tx);
        return {value,writes};
      };
      if(retry)await apply(); // Firestore may re-run this callback before commit.
      const {value,writes}=await apply();
      for(const [path,value] of writes){docs.set(path,value);written.push(path);}
      return value;
    }
  };
  return {db,docs,written,ids};
}
const now=i=>new Date(Date.UTC(2026,9,22,9,i)).toISOString();
const intent=(type,i=0,extra={},caseId='case1')=>({orderId:'O',itemId:'I',caseId,
  event:{id:'op'+i,type,occurredAt:now(i),...extra}});
const commit=(f,data)=>commitServiceCaseEvent(f.db,'U',data);
test('sales can log customer Bio-Plex sample custody but not fake experiment or report',async()=>{
  const f=fixture();
  const sent=await commit(f,intent('SAMPLE_RECEIVED'));
  assert.equal(sent.workStatus,'IN_PROGRESS');
  assert.equal(sent.custody,'IN_HOUSE');
  assert.equal(f.written.length,1);
  await assert.rejects(commit(f,intent('EXPERIMENT_COMPLETED',1)),/權限/);
  assert.equal(f.written.length,1);
  assert.deepEqual([...f.docs.keys()].filter(x=>/^(inventory|inventoryLots|inventoryMovements|supplyOrders|receipts|deliveryRecords)\//.test(x)),[]);
  assert.equal(f.docs.get('orders/O').items[0].deliveredQty,undefined);
});
test('engineer closes Bio-Plex only after sample receipt and actual report evidence',async()=>{
  const f=fixture({role:'engineer'});
  await assert.rejects(commit(f,intent('EXPERIMENT_COMPLETED')),/服務動作/);
  f.docs.set('users/U',{role:'sales',active:true});
  await commit(f,intent('SAMPLE_RECEIVED'));
  f.docs.set('users/U',{role:'engineer',active:true});
  await commit(f,intent('EXPERIMENT_COMPLETED',1));
  const done=await commit(f,intent('REPORT_SENT',2,{reportRef:'report/ABC'}));
  assert.equal(done.completed,true);
  assert.equal(done.workStatus,'COMPLETED');
  assert.equal(done.nextEvent,null);
  assert.equal(f.written.length,3);
  assert.equal(f.docs.get('orders/O').isDelivered,undefined);
  assert.equal(f.docs.get('orders/O').isBilled,undefined);
});
test('pipette warehouse must ship out, receive back, then return physical device to customer',async()=>{
  const f=fixture({role:'warehouse',kind:'PIPETTE_CALIBRATION'});
  await commit(f,intent('DEVICE_RECEIVED'));
  const shipped=await commit(f,intent('VENDOR_SENT',1,{partyName:'Calibrators'}));
  assert.equal(shipped.custody,'AT_VENDOR');
  const arrived=await commit(f,intent('VENDOR_RETURNED',2));
  assert.equal(arrived.custody,'IN_HOUSE');
  const done=await commit(f,intent('CUSTOMER_RETURNED',3,{receivedBy:'Customer A'}));
  assert.equal(done.custody,'RETURNED_TO_CUSTOMER');
  assert.equal(done.completed,true);
  assert.equal(f.written.length,4);
});
test('tissue outsourcer returns specimen and actual result before case completion',async()=>{
  const f=fixture({role:'warehouse',kind:'TISSUE_SLICING'});
  await commit(f,intent('SAMPLE_RECEIVED'));
  await commit(f,intent('VENDOR_SENT',1,{partyName:'Tissue Lab'}));
  const back=await commit(f,intent('VENDOR_RETURNED',2));
  assert.equal(back.completed,false);
  await assert.rejects(commit(f,intent('CUSTOMER_DELIVERED',3)),/憑證/);
  const done=await commit(f,intent('CUSTOMER_DELIVERED',3,{deliveryRef:'delivery/Z'}));
  assert.equal(done.completed,true);
});
test('onsite repair engineer closes with work summary and never creates virtual stock',async()=>{
  const f=fixture({role:'engineer',kind:'ONSITE_REPAIR'});
  await assert.rejects(commit(f,intent('REPAIR_COMPLETED',0)),/維修內容/);
  const done=await commit(f,intent('REPAIR_COMPLETED',0,{workSummary:'Adjusted optical alignment'}));
  assert.equal(done.completed,true);assert.equal(f.written.length,1);
  assert.equal([...f.docs.keys()].filter(k=>k.startsWith('inventory/')).length,0);
});
test('fixed operation retries are idempotent; changing evidence with same ID is rejected',async()=>{
  const f=fixture({retry:true});
  const data=intent('SAMPLE_RECEIVED');
  assert.equal((await commit(f,data)).status,'committed');
  assert.equal((await commit(f,data)).status,'already-applied');
  assert.equal(f.written.length,1);
  await assert.rejects(commit(f,intent('SAMPLE_RECEIVED',0,{notes:'new'})),/不同內容/);
  assert.equal(f.written.length,1);
});
test('Role, ownership, cancellation and live product type are validated inside transaction',async()=>{
  const variants=[
    [{role:'sales',ownerUid:'Other'},/權限/],
    [{role:'purchaser'},/權限/],
    [{role:'engineer'},/權限/],
    [{role:'sales',disabled:true},/權限/],
    [{role:'sales',orderStatus:'cancelled'},/取消/],
    [{role:'sales',initialized:false},/初始化/],
    [{role:'sales',productType:'GOODS'},/Service/],
    [{role:'sales',productMasterType:'GOODS'},/型別/],
    [{role:'sales',kind:'UNKNOWN'},/服務主檔/]
  ];
  for(const [options,error] of variants){
    const f=fixture(options);
    await assert.rejects(commit(f,intent('SAMPLE_RECEIVED')),error);
    assert.equal(f.written.length,0);
  }
});
test('Clients cannot select a cheaper service type, spoof actor, or append arbitrary fields',async()=>{
  const f=fixture();
  await assert.rejects(commit(f,{...intent('SAMPLE_RECEIVED'),kind:'ONSITE_REPAIR'}),/格式/);
  await assert.rejects(commit(f,{...intent('SAMPLE_RECEIVED'),event:{...intent('SAMPLE_RECEIVED').event,actorUid:'Other'}}),/身分/);
  await assert.rejects(commit(f,{...intent('SAMPLE_RECEIVED'),event:{...intent('SAMPLE_RECEIVED').event,stockQty:500}}),/未授權/);
  assert.equal(f.written.length,0);
});
test('Each service case has a distinct deterministic key even if IDs include separators',()=>{
  assert.notEqual(caseDocId('a|b','c','d'),caseDocId('a','b|c','d'));
  assert.notEqual(caseDocId('a','b|c','d'),caseDocId('a','b','c|d'));
  assert.throws(()=>caseDocId('O','I','../unsafe'),/識別碼/);
});

test('live Service product master selects mandatory workflow, not a caller-editable order type',async()=>{
  const mismatch=fixture({kind:'BIOPLEX_LAB'});
  mismatch.docs.get('orders/O').items[0].serviceKind='ONSITE_REPAIR';
  await assert.rejects(commit(mismatch,intent('SAMPLE_RECEIVED')),/不一致/);
  assert.equal(mismatch.written.length,0);

  const noMasterKind=fixture({kind:'BIOPLEX_LAB'});
  delete noMasterKind.docs.get('products/P').serviceKind;
  await assert.rejects(commit(noMasterKind,intent('SAMPLE_RECEIVED')),/正式服務主檔/);
  assert.equal(noMasterKind.written.length,0);
});

test('historic cancellation aliases and duplicate Service item IDs reject atomically',async()=>{
 for(const state of ['cancelled','canceled','void','voided','deleted','closed','已取消','作廢','已結案']){
   const f=fixture({orderStatus:state});
   await assert.rejects(commit(f,intent('SAMPLE_RECEIVED')),/取消|結案/);
   assert.equal(f.written.length,0);
 }
 const f=fixture();
 f.docs.get('orders/O').items.push({itemId:'I',productId:'P',productType:'SERVICE',serviceKind:'BIOPLEX_LAB',qty:1});
 await assert.rejects(commit(f,intent('SAMPLE_RECEIVED')),/重複/);
 assert.equal(f.written.length,0);
});

test('authorized case query reads actual custody without fabricating an unregistered case',async()=>{
  const f=fixture();
  const locator={orderId:'O',itemId:'I',caseId:'case1'};
  const missing=await getServiceCaseStatus(f.db,'U',locator);
  assert.equal(missing.exists,false);
  assert.equal(missing.workStatus,'NOT_STARTED');
  assert.equal(missing.nextEvent,null);
  assert.equal(f.written.length,0);
  await commit(f,intent('SAMPLE_RECEIVED'));
  const progress=await getServiceCaseStatus(f.db,'U',locator);
  assert.equal(progress.exists,true);
  assert.equal(progress.workStatus,'IN_PROGRESS');
  assert.equal(progress.custody,'IN_HOUSE');
  assert.equal(progress.nextEvent,'EXPERIMENT_COMPLETED');
  assert.equal(progress.events[0].actorUid,'U');
  assert.equal(f.written.length,1); // no write on read
  f.docs.get('orders/O').orderStatus='cancelled';
  assert.equal((await getServiceCaseStatus(f.db,'U',locator)).events.length,1);
});
test('case status lookup denies foreign sales, disabled roles, forged item, or extra fields',async()=>{
  const locator={orderId:'O',itemId:'I',caseId:'case1'};
  const denied=[
    {role:'sales',ownerUid:'Other'},
    {role:'purchaser'},
    {role:'sales',disabled:true}
  ];
  for(const options of denied){
    const f=fixture(options);
    await assert.rejects(getServiceCaseStatus(f.db,'U',locator),/權限/);
    assert.equal(f.written.length,0);
  }
  const f=fixture();
  await assert.rejects(getServiceCaseStatus(f.db,'U',{...locator,actorUid:'U'}),/格式/);
  await assert.rejects(getServiceCaseStatus(f.db,'U',{...locator,itemId:'Other'}),/來源/);
  f.docs.get('orders/O').items[0].productType='GOODS';
  await assert.rejects(getServiceCaseStatus(f.db,'U',locator),/型別/);
  assert.equal(f.written.length,0);
});
test('case status lookup does not trust corrupt storage snapshots',async()=>{
  const f=fixture();
  const locator={orderId:'O',itemId:'I',caseId:'case1'};
  f.docs.set('serviceCases/'+caseDocId('O','I','case1'),{
    orderId:'O',itemId:'OTHER',caseId:'case1',kind:'BIOPLEX_LAB',events:[]
  });
  await assert.rejects(getServiceCaseStatus(f.db,'U',locator),/不一致/);
  f.docs.get('serviceCases/'+caseDocId('O','I','case1')).itemId='I';
  f.docs.get('serviceCases/'+caseDocId('O','I','case1')).events=[
    {id:'op1',type:'REPORT_SENT',actorUid:'U',occurredAt:now(0),reportRef:'x'}
  ];
  await assert.rejects(getServiceCaseStatus(f.db,'U',locator),/順序/);
  assert.equal(f.written.length,0);
});
