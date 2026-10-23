'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {commitServiceCaseEvent,getServiceCaseStatus,getServiceOrderProgress,caseDocId,itemCaseIndexId}=require('../functions/service-case-service.js');

function fixture({role='sales',ownerUid='U',kind='BIOPLEX_LAB',productType='SERVICE',
  productMasterType='SERVICE',orderStatus='normal',initialized=true,disabled=false,retry=false,rejectOrderUpdate=false}={}){
  const clone=x=>x===undefined?undefined:structuredClone(x);
  const docs=new Map([
    ['users/U',{role,active:!disabled,disabled}],
    ['orders/O',{ownerUid,orderStatus,inventoryReservationStatus:initialized?'completed':'pending',
      items:[{itemId:'I',productId:'P',productType,serviceKind:kind,qty:1}]}],
    ['products/P',{active:true,productType:productMasterType,serviceKind:kind}]
  ]);
  const ids=[],written=[],orderWrites=[];
  const query=(name,filters=[])=>({query:name,filters,
    where:(field,op,value)=>query(name,[...filters,[field,value]]),limit:()=>query(name,filters)});
  const db={collection:name=>({...query(name),doc:id=>({path:name+'/'+id})}),
    runTransaction:async callback=>{
      const apply=async()=>{
        const writes=[];
        const tx={
          get:async ref=>{
            if(!ref.query)return {exists:docs.has(ref.path),data:()=>clone(docs.get(ref.path))};
            const rows=[...docs].filter(([path,row])=>path.startsWith(ref.query+'/')&&ref.filters.every(([key,value])=>row[key]===value));
            return {empty:!rows.length,size:rows.length,docs:rows.map(([path,row])=>({id:path.split('/')[1],data:()=>clone(row)}))};
          },
          set:(ref,value)=>writes.push([ref.path,clone(value),'set']),
          update:(ref,value)=>{
            if(rejectOrderUpdate&&ref.path.startsWith('orders/'))throw Error('simulated order index write failure');
            writes.push([ref.path,clone(value),'update']);
          }
        };
        const value=await callback(tx);
        return {value,writes};
      };
      if(retry)await apply(); // Firestore may re-run this callback before commit.
      const {value,writes}=await apply();
      for(const [path,value,method] of writes){
        if(method==='update'){
          if(!docs.has(path))throw Error('Cannot update missing document');
          Object.assign(docs.get(path),value);
        }else docs.set(path,value);
        if(path.startsWith('serviceCases/'))written.push(path);
        else orderWrites.push(path);
      }
      return value;
    }
  };
  return {db,docs,written,orderWrites,ids};
}
const now=i=>new Date(Date.UTC(2026,9,22,9,i)).toISOString();
const intent=(type,i=0,extra={},caseId='case1')=>({orderId:'O',itemId:'I',caseId,serviceQty:1,
  event:{id:'op'+i,type,occurredAt:now(i),...extra}});
const commit=(f,data)=>commitServiceCaseEvent(f.db,'U',data);
test('sales can log customer Bio-Plex sample custody but not fake experiment or report',async()=>{
  const f=fixture();
  const sent=await commit(f,intent('SAMPLE_RECEIVED'));
  assert.equal(sent.workStatus,'IN_PROGRESS');
  assert.equal(sent.custody,'IN_HOUSE');
  assert.equal(f.written.length,2);
  await assert.rejects(commit(f,intent('EXPERIMENT_COMPLETED',1)),/權限/);
  assert.equal(f.written.length,2);
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
  assert.equal(done.itemWorkCategory,'billing');
  assert.equal(f.written.length,4);
  assert.equal(f.docs.get('orders/O').isDelivered,undefined);
  assert.equal(f.docs.get('orders/O').isBilled,undefined);
});
test('single-line Service index advances from real completion evidence in the same transaction',async()=>{
  const f=fixture({role:'engineer',kind:'ONSITE_REPAIR'});
  const order=f.docs.get('orders/O');
  order.workCategories=['delivery'];
  const done=intent('REPAIR_COMPLETED',0,{workSummary:'完工證明'});
  const first=await commit(f,done);
  assert.equal(first.status,'committed');
  assert.equal(first.itemWorkCategory,'billing');
  assert.deepEqual(order.workCategories,['billing']);
  assert.ok(/^2026-|^20/.test(order.workCategoryUpdatedAt));
  assert.deepEqual(f.orderWrites,['orders/O']);
  assert.equal(f.written.length,2);
  const previousIndexTime=order.workCategoryUpdatedAt;
  const retry=await commit(f,done);
  assert.equal(retry.status,'already-applied');
  assert.equal(order.workCategoryUpdatedAt,previousIndexTime);
  assert.deepEqual(f.orderWrites,['orders/O']);
  assert.equal(f.written.length,2);
  assert.equal(order.items[0].deliveredQty,undefined);
  assert.equal(order.isBilled,undefined);
});
test('Service work index initializes missing status without altering Goods or guessing other Service lines',async()=>{
  const missing=fixture();
  const first=await commit(missing,intent('SAMPLE_RECEIVED'));
  assert.equal(first.itemWorkCategory,'delivery');
  assert.deepEqual(missing.docs.get('orders/O').workCategories,['delivery']);
  assert.deepEqual(missing.orderWrites,['orders/O']);

  for(const sibling of ['GOODS','SERVICE']){
    const f=fixture({role:'engineer',kind:'ONSITE_REPAIR'});
    const order=f.docs.get('orders/O');
    order.workCategories=['delivery','ordering'];
    order.items.push(sibling==='GOODS'
      ?{itemId:'G',productId:'PG',productType:'GOODS',qty:2}
      :{itemId:'J',productId:'PJ',productType:'SERVICE',serviceKind:'ONSITE_REPAIR',qty:2});
    await commit(f,intent('REPAIR_COMPLETED',0,{workSummary:'完成第一項'}));
    assert.deepEqual(order.workCategories,['delivery','ordering']);
    assert.deepEqual(f.orderWrites,[]);
    assert.equal(f.written.length,2);
  }
});
test('failure updating the single-line work index aborts Service case and case-index writes',async()=>{
  const f=fixture({role:'engineer',kind:'ONSITE_REPAIR',rejectOrderUpdate:true});
  f.docs.get('orders/O').workCategories=['delivery'];
  await assert.rejects(commit(f,intent('REPAIR_COMPLETED',0,{workSummary:'已完成'})),/simulated order index write failure/);
  assert.equal(f.docs.has('serviceCases/'+caseDocId('O','I','case1')),false);
  assert.equal(f.docs.has('serviceCases/'+itemCaseIndexId('O','I')),false);
  assert.deepEqual(f.docs.get('orders/O').workCategories,['delivery']);
  assert.deepEqual(f.written,[]);
  assert.deepEqual(f.orderWrites,[]);
});
test('service workflow reads use registered events and the live billing and lifecycle state, with no order writes',async()=>{
  const f=fixture({role:'admin',kind:'ONSITE_REPAIR'}),order=f.docs.get('orders/O');
  order.items[0].qty=2;
  order.items.push({itemId:'G',productId:'GOODS',productType:'Goods',qty:1,reservedQty:1});
  const query={orderId:'O',itemId:'I'};
  assert.equal((await getServiceCaseStatus(f.db,'U',query)).itemWorkCategory,'delivery');
  const first=intent('REPAIR_COMPLETED',0,{workSummary:'修復'},'first');
  assert.equal((await commit(f,first)).itemWorkCategory,'delivery');
  assert.equal((await getServiceCaseStatus(f.db,'U',query)).itemProgress.completedQty,1);
  assert.equal((await commit(f,intent('REPAIR_COMPLETED',1,{workSummary:'修復'},'second'))).itemWorkCategory,'billing');
  assert.equal((await getServiceCaseStatus(f.db,'U',query)).itemWorkCategory,'billing');
  order.isBilled=true;
  assert.equal((await getServiceCaseStatus(f.db,'U',query)).itemWorkCategory,'complete');
  assert.equal((await getServiceCaseStatus(f.db,'U',{...query,caseId:'first'})).itemWorkCategory,'complete');
  order.orderStatus='cancelled';
  assert.equal((await getServiceCaseStatus(f.db,'U',query)).itemWorkCategory,'closed');
  assert.ok(f.written.every(path=>path.startsWith('serviceCases/')));
  assert.equal(order.items[1].reservedQty,1);assert.equal(order.isDelivered,undefined);
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
  assert.equal(f.written.length,5);
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
  assert.equal(done.completed,true);assert.equal(f.written.length,2);
  assert.equal([...f.docs.keys()].filter(k=>k.startsWith('inventory/')).length,0);
});
test('fixed operation retries are idempotent; changing evidence with same ID is rejected',async()=>{
  const f=fixture({retry:true});
  const data=intent('SAMPLE_RECEIVED');
  assert.equal((await commit(f,data)).status,'committed');
  assert.equal((await commit(f,data)).status,'already-applied');
  assert.equal(f.written.length,2);
  await assert.rejects(commit(f,intent('SAMPLE_RECEIVED',0,{notes:'new'})),/不同內容/);
  assert.equal(f.written.length,2);
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
  assert.equal(f.written.length,2); // no write on read
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
    orderId:'O',itemId:'OTHER',caseId:'case1',productId:'P',kind:'BIOPLEX_LAB',events:[]
  });
  await assert.rejects(getServiceCaseStatus(f.db,'U',locator),/不一致/);
  f.docs.get('serviceCases/'+caseDocId('O','I','case1')).itemId='I';
  f.docs.get('serviceCases/'+caseDocId('O','I','case1')).events=[
    {id:'op1',type:'REPORT_SENT',actorUid:'U',occurredAt:now(0),reportRef:'x'}
  ];
  await assert.rejects(getServiceCaseStatus(f.db,'U',locator),/順序/);
  assert.equal(f.written.length,0);
});

test('case product binding rejects replacement products on reads, continuation and replay',async()=>{
  const f=fixture();
  const first=intent('SAMPLE_RECEIVED');
  const locator={orderId:'O',itemId:'I',caseId:'case1'};
  await commit(f,first);
  const key='serviceCases/'+caseDocId('O','I','case1');
  assert.equal(f.docs.get(key).productId,'P');
  const original=structuredClone(f.docs.get(key));
  f.docs.set('products/Q',{active:true,productType:'SERVICE',serviceKind:'BIOPLEX_LAB'});
  f.docs.get('orders/O').items[0].productId='Q';
  await assert.rejects(getServiceCaseStatus(f.db,'U',locator),/原產品識別/);
  await assert.rejects(commit(f,first),/原產品識別/);
  f.docs.set('users/U',{role:'engineer',active:true});
  await assert.rejects(commit(f,intent('EXPERIMENT_COMPLETED',1)),/原產品識別/);
  assert.deepEqual(f.docs.get(key),original);
  assert.equal(f.written.length,2);
});

test('historical custody survives inactive master but rejects unbound cases and changed item workflow',async()=>{
  const f=fixture(),locator={orderId:'O',itemId:'I',caseId:'case1'};
  await commit(f,intent('SAMPLE_RECEIVED'));
  f.docs.delete('products/P'); // audit history is not controlled by the live catalogue
  f.docs.get('orders/O').orderStatus='cancelled';
  assert.equal((await getServiceCaseStatus(f.db,'U',locator)).custody,'IN_HOUSE');
  f.docs.get('orders/O').items[0].serviceKind='ONSITE_REPAIR';
  await assert.rejects(getServiceCaseStatus(f.db,'U',locator),/類型不一致/);
  f.docs.get('orders/O').items[0].serviceKind='BIOPLEX_LAB';
  delete f.docs.get('serviceCases/'+caseDocId('O','I','case1')).productId;
  await assert.rejects(getServiceCaseStatus(f.db,'U',locator),/尚未綁定/);
  assert.equal(f.written.length,2);
});

test('item index bounds case quantities and same case retries cannot change allocation',async()=>{
  const f=fixture();f.docs.get('orders/O').items[0].qty=3;
  const a={...intent('SAMPLE_RECEIVED'),serviceQty:2};
  const first=await commit(f,a);
  assert.equal(first.itemProgress.unassignedQty,1);
  const b=intent('SAMPLE_RECEIVED',0,{},'case2');
  const second=await commit(f,b);
  assert.equal(second.itemProgress.allocatedQty,3);
  const before=structuredClone([...f.docs]);
  await assert.rejects(commit(f,intent('SAMPLE_RECEIVED',0,{},'excess')),/超過訂單數量/);
  await assert.rejects(commit(f,{...a,serviceQty:1}),/數量已固定/);
  assert.equal((await commit(f,a)).status,'already-applied');
  assert.deepEqual([...f.docs],before);
  f.docs.set('users/U',{role:'engineer',active:true});
  await commit(f,{...intent('EXPERIMENT_COMPLETED',1),serviceQty:2});
  const done=await commit(f,{...intent('REPORT_SENT',2,{reportRef:'R'}),serviceQty:2});
  assert.equal(done.itemProgress.completedQty,2);
  const history=await getServiceCaseStatus(f.db,'U',{orderId:'O',itemId:'I',caseId:'case2'});
  assert.equal(history.serviceQty,1);assert.equal(history.itemProgress.remainingQty,1);
  assert.equal(f.docs.get('orders/O').isDelivered,undefined);
});
test('corrupt index, missing linked cases and reduced order quantity reject without writes',async()=>{
  for(const damage of ['missing-case','wrong-product','duplicate','reduced-qty']){
    const f=fixture();await commit(f,intent('SAMPLE_RECEIVED'));
    const index=f.docs.get('serviceCases/'+itemCaseIndexId('O','I'));
    if(damage==='missing-case')f.docs.delete('serviceCases/'+caseDocId('O','I','case1'));
    if(damage==='wrong-product')index.productId='Q';
    if(damage==='duplicate')index.caseIds.push('case1');
    if(damage==='reduced-qty')f.docs.get('orders/O').items[0].qty=0.5;
    f.docs.set('users/U',{role:'engineer',active:true});
    const before=structuredClone([...f.docs]),writes=f.written.length;
    await assert.rejects(commit(f,intent('EXPERIMENT_COMPLETED',1)),/索引|超過/);
    assert.equal(f.written.length,writes);assert.deepEqual([...f.docs],before);
  }
});
test('old pilot history stays readable but new allocation never guesses its missing quantity',async()=>{
  const f=fixture();await commit(f,intent('SAMPLE_RECEIVED'));
  delete f.docs.get('serviceCases/'+caseDocId('O','I','case1')).serviceQty;
  f.docs.delete('serviceCases/'+itemCaseIndexId('O','I'));
  const old=await getServiceCaseStatus(f.db,'U',{orderId:'O',itemId:'I',caseId:'case1'});
  assert.equal(old.itemProgress,null);assert.equal(old.custody,'IN_HOUSE');
  const writes=f.written.length;
  await assert.rejects(commit(f,intent('SAMPLE_RECEIVED',0,{},'new')),/不能自動補綁/);
  assert.equal(f.written.length,writes);
});
test('index namespace cannot collide with externally supplied case identifiers',()=>{
  assert.notEqual(itemCaseIndexId('O','I'),caseDocId('item-index','O','I|v1'));
});
test('item lookup returns bounded cases and server role hints without writes or price fields',async()=>{
  const f=fixture();f.docs.get('orders/O').orderNo='YS-1';f.docs.get('orders/O').totalPrice=999;
  f.docs.get('products/P').serviceKind=' bioplex_lab ';
  const summary=await getServiceCaseStatus(f.db,'U',{orderNo:'YS-1'});
  assert.equal(summary.orderId,'O');assert.equal(summary.totalPrice,undefined);
  const empty=await getServiceCaseStatus(f.db,'U',{orderId:'O',itemId:'I'});
  assert.equal(empty.canStart,true);assert.equal(empty.cases.length,0);assert.equal(f.written.length,0);
  await commit(f,intent('SAMPLE_RECEIVED'));
  const sales=await getServiceCaseStatus(f.db,'U',{orderId:'O',itemId:'I'});
  assert.equal(sales.cases[0].canAdvance,false);
  f.docs.set('users/U',{role:'engineer',active:true});
  const engineer=await getServiceCaseStatus(f.db,'U',{orderId:'O',itemId:'I'});
  assert.equal(engineer.canStart,false);assert.equal(engineer.cases[0].canAdvance,true);
  f.docs.get('orders/O').orderStatus='cancelled';
  assert.equal((await getServiceCaseStatus(f.db,'U',{orderId:'O',itemId:'I'})).cases[0].canAdvance,false);
  assert.equal(f.written.length,2);
});
test('order-number service lookup enforces owner, current role and unique references',async()=>{
  const f=fixture({ownerUid:'Other'});f.docs.get('orders/O').orderNo='YS-1';
  await assert.rejects(getServiceCaseStatus(f.db,'U',{orderNo:'YS-1'}),/權限/);
  f.docs.set('users/U',{role:'engineer',active:true});
  assert.equal((await getServiceCaseStatus(f.db,'U',{orderNo:'YS-1'})).orderId,'O');
  f.docs.set('orders/duplicate',{...f.docs.get('orders/O')});
  await assert.rejects(getServiceCaseStatus(f.db,'U',{orderNo:'YS-1'}),/重複/);
  f.docs.set('users/U',{role:'engineer',active:false});
  await assert.rejects(getServiceCaseStatus(f.db,'U',{orderNo:'YS-1'}),/權限/);
  assert.equal(f.written.length,0);
});

test('item action hints respect remaining allocation while allowing existing cases to advance',async()=>{
 const f=fixture({role:'admin'}),query={orderId:'O',itemId:'I'};
 assert.equal((await getServiceCaseStatus(f.db,'U',query)).canStart,true);
 await commit(f,intent('SAMPLE_RECEIVED'));
 const allocated=await getServiceCaseStatus(f.db,'U',query);
 assert.equal(allocated.canStart,false);
 assert.equal(allocated.cases[0].canAdvance,true);
 f.docs.get('orders/O').items[0].qty=2;
 assert.equal((await getServiceCaseStatus(f.db,'U',query)).canStart,true);
 const index=f.docs.get('serviceCases/'+itemCaseIndexId('O','I'));
 const original=f.docs.get('serviceCases/'+caseDocId('O','I','case1'));
 for(let i=1;i<100;i++){
   const caseId='bounded-'+i;
   index.caseIds.push(caseId);
   f.docs.set('serviceCases/'+caseDocId('O','I',caseId),{...structuredClone(original),caseId,serviceQty:0.001});
 }
 const bounded=await getServiceCaseStatus(f.db,'U',query);
 assert.ok(bounded.itemProgress.unassignedQty>0);
 assert.equal(bounded.canStart,false);
 assert.ok(bounded.cases.every(c=>c.canAdvance));
 assert.equal(f.written.length,2);
});
test('changed or removed live master keeps bound history readable but offers no rejected actions',async()=>{
 const f=fixture({role:'admin'}),query={orderId:'O',itemId:'I'};
 f.docs.get('orders/O').items[0].qty=2;
 await commit(f,intent('SAMPLE_RECEIVED'));
 const original=structuredClone(f.docs.get('products/P'));
 const before=structuredClone(f.docs.get('serviceCases/'+caseDocId('O','I','case1')));
 for(const patch of [{active:false},{productType:'Goods'},{serviceKind:'ONSITE_REPAIR'},
   {serviceKind:'UNKNOWN'},null]){
   if(patch===null)f.docs.delete('products/P');
   else f.docs.set('products/P',{...original,...patch});
   const history=await getServiceCaseStatus(f.db,'U',query);
   assert.equal(history.kind,'BIOPLEX_LAB');
   assert.equal(history.canStart,false);
   assert.equal(history.cases[0].canAdvance,false);
   assert.equal(history.cases[0].events.length,1);
   assert.equal(history.cases[0].custody,'IN_HOUSE');
   await assert.rejects(commit(f,intent('EXPERIMENT_COMPLETED',1)));
 }
 f.docs.set('products/P',original);
 const restored=await getServiceCaseStatus(f.db,'U',query);
 assert.equal(restored.canStart,true);assert.equal(restored.cases[0].canAdvance,true);
 assert.deepEqual(f.docs.get('serviceCases/'+caseDocId('O','I','case1')),before);
 assert.equal(f.written.length,2);
});
test('item summary rejects mismatched order service type before a case exists',async()=>{
 const f=fixture(),query={orderId:'O',itemId:'I'};
 f.docs.get('orders/O').items[0].serviceKind='ONSITE_REPAIR';
 await assert.rejects(getServiceCaseStatus(f.db,'U',query),/類型不一致/);
 await assert.rejects(commit(f,intent('SAMPLE_RECEIVED')),/不一致/);
 assert.equal(f.written.length,0);
});

test('bounded whole-order read verifies partial/full Service work and never uses physical delivery flags',async()=>{
 const f=fixture({role:'admin',kind:'ONSITE_REPAIR'});
 const order=f.docs.get('orders/O');order.items[0].qty=2;
 order.items[0].deliveredQty=500;order.isDelivered=true;
 let p=await getServiceOrderProgress(f.db,'U',{orderId:'O'});
 assert.equal(p.completedQty,0);assert.equal(p.outstandingQty,2);
 assert.equal(p.items[0].workCategory,'delivery');assert.equal(p.serviceCompleted,false);
 await commit(f,intent('REPAIR_COMPLETED',0,{workSummary:'固定'},'case1'));
 p=await getServiceOrderProgress(f.db,'U',{orderId:'O'});
 assert.equal(p.completedQty,1);assert.equal(p.outstandingQty,1);
 await commit(f,intent('REPAIR_COMPLETED',1,{workSummary:'完成'},'case2'));
 p=await getServiceOrderProgress(f.db,'U',{orderId:'O'});
 assert.equal(p.completedQty,2);assert.equal(p.serviceCompleted,true);
 assert.equal(p.items[0].workCategory,'billing');
 order.isBilled=true;p=await getServiceOrderProgress(f.db,'U',{orderId:'O'});
 assert.equal(p.items[0].workCategory,'complete');
 order.orderStatus='cancelled';p=await getServiceOrderProgress(f.db,'U',{orderId:'O'});
 assert.equal(p.items[0].workCategory,'closed');
 assert.ok(f.written.every(path=>path.startsWith('serviceCases/')));
});
test('whole-order summary handles two Service lines and mixed Goods without inventing goods completion',async()=>{
 const f=fixture({role:'admin',kind:'ONSITE_REPAIR'});
 const order=f.docs.get('orders/O');
 order.items.push({itemId:'J',productId:'PJ',productType:'SERVICE',serviceKind:'ONSITE_REPAIR',qty:1});
 order.items.push({itemId:'G',productId:'PG',productType:'Goods',qty:4,deliveredQty:4});
 f.docs.set('products/PJ',{active:true,productType:'SERVICE',serviceKind:'ONSITE_REPAIR'});
 await commit(f,intent('REPAIR_COMPLETED',0,{workSummary:'完成第一項'}));
 let p=await getServiceOrderProgress(f.db,'U',{orderId:'O'});
 assert.equal(p.serviceItemCount,2);
 assert.equal(p.mixedOrder,true);
 assert.equal(p.orderedQty,2);
 assert.equal(p.completedQty,1);
 assert.equal(p.serviceCompleted,false);
 assert.deepEqual(p.items.map(i=>i.itemId),['I','J']);
 assert.equal(p.items[1].workCategory,'delivery');
 assert.equal(order.items[2].deliveredQty,4);
 assert.equal(f.docs.get('orders/O').workCategories,undefined);
});
test('whole-order read requires actor authorization, stable identifiers, consistent case indexes',async()=>{
 for(const opt of [{role:'purchaser'},{role:'sales',ownerUid:'OTHER'},{role:'sales',disabled:true}]){
   const f=fixture(opt);
   await assert.rejects(getServiceOrderProgress(f.db,'U',{orderId:'O'}),/權限/);
   assert.equal(f.written.length,0);
 }
 const f=fixture();
 for(const q of [{orderId:'O',itemId:'I'},{orderId:'../O'},{orderId:'O',isBilled:true},{}])
   await assert.rejects(getServiceOrderProgress(f.db,'U',q),/格式|識別碼/);
 f.docs.get('orders/O').items.push({...f.docs.get('orders/O').items[0]});
 await assert.rejects(getServiceOrderProgress(f.db,'U',{orderId:'O'}),/重複/);
 f.docs.get('orders/O').items.pop();
 await commit(f,intent('SAMPLE_RECEIVED'));
 f.docs.get('serviceCases/'+itemCaseIndexId('O','I')).caseIds.push('missing');
 await assert.rejects(getServiceOrderProgress(f.db,'U',{orderId:'O'}),/不存在/);
 assert.equal(f.docs.get('orders/O').isBilled,undefined);
});
test('whole-order summary caps total index fanout before case document reads',async()=>{
 const f=fixture({role:'admin',kind:'ONSITE_REPAIR'});
 f.docs.get('orders/O').items.push({itemId:'J',productId:'PJ',productType:'SERVICE',serviceKind:'ONSITE_REPAIR',qty:1});
 f.docs.set('products/PJ',{active:true,productType:'SERVICE',serviceKind:'ONSITE_REPAIR'});
 for(const [itemId,productId] of [['I','P'],['J','PJ']]){
   f.docs.set('serviceCases/'+itemCaseIndexId('O',itemId),{
     recordType:'ITEM_CASE_INDEX',orderId:'O',itemId,productId,kind:'ONSITE_REPAIR',
     caseIds:Array.from({length:51},(_,i)=>itemId+i)});
 }
 await assert.rejects(getServiceOrderProgress(f.db,'U',{orderId:'O'}),/查核上限/);
 assert.equal(f.written.length,0);
});
