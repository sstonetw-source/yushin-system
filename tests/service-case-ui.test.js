'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('src/features/orders/service-cases.js','utf8'),core=require('../modules/service-work-core');
function fixture(){
 const nodes=new Map(),calls=[];let saved=null,send=async()=>({orderId:'O',itemId:'I'}),read=async()=>data,
  readOrder=async()=>({orderId:'O',orderedQty:2,completedQty:1,mixedOrder:false,items:[{itemId:'I',itemName:'檢測',orderedQty:2,completedQty:1,workCategory:'delivery'}]});
 const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',textContent:'',classList:{add(){},remove(){}},setAttribute(){},removeAttribute(){}});return nodes.get(id);};
 const data={orderId:'O',itemId:'I',kind:'BIOPLEX_LAB',canStart:true,cases:[],
  itemProgress:{orderedQty:2,allocatedQty:0,completedQty:0,remainingQty:2,unassignedQty:2}};
 const c=vm.createContext({Date,crypto:require('node:crypto'),currentUser:{uid:'U'},currentUserRole:'sales',sessionDataGeneration:1,
  YUSHIN_SERVICE_CASE_EMULATOR:true,YushinServiceWork:core,
  ordersCache:[{id:'O',orderNo:'YS-1',items:[{itemId:'I',productType:'SERVICE',itemName:'檢測'}]}],
  document:{getElementById:node,createElement:()=>node('serviceCaseOverlay'),body:{appendChild(){}}},
  escapeHtml:x=>String(x??'').replaceAll('<','&lt;'),escapeAttr:x=>String(x??'').replaceAll('"','&quot;'),inlineJsValue:JSON.stringify,
  alert:()=>{},serviceCaseTransport:()=>({uid:'U',role:'sales'}),pendingServiceCaseIntent:()=>saved,
  readServiceCases:async input=>read(input),readServiceOrderProgress:async orderId=>readOrder(orderId),
  commitServiceCaseIntent:async input=>{calls.push(input);return send(input);}});
 c.globalThis=c;c.window=c;vm.runInContext(source,c);
 return {c,node,calls,data,setPending:v=>saved=v,setSend:f=>send=f,setRead:f=>read=f,setReadOrder:f=>readOrder=f};
}
test('service form double taps send once; unknown result exposes immutable recovery and reload never submits',async()=>{
 const f=fixture();await f.c.openServiceCases('O');
 f.node('serviceOccurredAt').value='2026-10-23T10:00:00';f.node('serviceNewCaseId').value='sample-1';f.node('serviceNewQty').value='1';
 let reject;f.setSend(input=>new Promise((_,r)=>{f.setPending({intent:input});reject=r;}));
 const first=f.c.saveServiceCaseAction();await f.c.saveServiceCaseAction();assert.equal(f.calls.length,1);
 reject(Error('reply lost'));await first;
 assert.match(f.node('serviceCaseBody').innerHTML,/確認前次服務操作結果/);
 await f.c.openServiceCases('O');assert.equal(f.calls.length,1);
});
test('old item replies cannot overwrite a newer selection or a reset session',async()=>{
 const f=fixture();await f.c.openServiceCases('O');
 const replies=[];f.setRead(()=>new Promise(resolve=>replies.push(resolve)));
 const first=f.c.loadServiceCaseItem('I'),second=f.c.loadServiceCaseItem('J');
 replies[1]({...f.data,itemId:'J',itemProgress:{...f.data.itemProgress,orderedQty:9}});await second;
 const before=f.node('serviceItemBody').innerHTML;
 replies[0]({...f.data,itemId:'I'});await first;assert.equal(f.node('serviceItemBody').innerHTML,before);
 const old=f.c.loadServiceCaseItem('I');f.c.resetServiceCaseView();replies[2](f.data);await old;
 assert.equal(f.node('serviceCaseOverlay').innerHTML,'');assert.equal(f.calls.length,0);
});
test('server role hints control actions and customer data is escaped before display',async()=>{
 const f=fixture();f.data.canStart=false;
 f.data.cases=[{caseId:'<img>',serviceQty:1,completed:false,nextEvent:'EXPERIMENT_COMPLETED',custody:'IN_HOUSE',events:[],canAdvance:false}];
 await f.c.openServiceCases('O');
 assert.match(f.node('serviceItemBody').innerHTML,/&lt;img>/);assert.doesNotMatch(f.node('serviceCaseAction').innerHTML,/serviceCaseSave/);
 assert.equal(f.calls.length,0);
});
test('service item status displays the server workflow and never infers fulfillment from UI counts',async()=>{
 const f=fixture();f.data.itemProgress.completedQty=2;
 for(const [category,label] of [['delivery','待服務處理'],['billing','服務完成・待核銷'],['complete','服務完成・已核銷'],['closed','訂單已停止履約']]){
  f.data.itemWorkCategory=category;await f.c.openServiceCases('O');
  assert.ok(f.node('serviceItemBody').innerHTML.includes(label));
 }
});
test('order lookup invalidates old actions; a failed query cannot submit the previous case',async()=>{
 const f=fixture();await f.c.openServiceCases('O');
 f.node('serviceOccurredAt').value='2026-10-23T10:00:00';f.node('serviceNewCaseId').value='old-case';f.node('serviceNewQty').value='1';
 let reject;const reads=[];
 f.setRead(input=>{reads.push(input);return new Promise((_,r)=>reject=r);});
 f.node('serviceOrderNo').value='YS-OTHER';const lookup=f.c.findServiceCaseOrder();
 await f.c.saveServiceCaseAction();await f.c.loadServiceCaseItem('I');
 assert.equal(f.calls.length,0);assert.equal(reads.length,1);assert.equal(f.node('serviceItemChoice').disabled,true);
 reject(Error('order not found'));await lookup;await f.c.saveServiceCaseAction();
 assert.equal(f.calls.length,0);assert.match(f.node('serviceCaseMessage').textContent,/查詢/);
});
test('new order lookup supersedes an old item read and keeps the new order bound through submission',async()=>{
 const f=fixture();await f.c.openServiceCases('O');
 let resolveOld,resolveOrder;const reads=[];
 f.setRead(input=>{
  reads.push(input);
  if(input.orderNo)return new Promise(resolve=>resolveOrder=resolve);
  if(input.orderId==='O')return new Promise(resolve=>resolveOld=resolve);
  return {...f.data,orderId:'NEW',itemId:'NEW-I'};
 });
 const old=f.c.loadServiceCaseItem('I');f.node('serviceOrderNo').value='YS-NEW';
 const lookup=f.c.findServiceCaseOrder();resolveOld(f.data);await old;
 assert.equal(f.node('serviceItemBody').textContent,'查詢訂單中…');
 resolveOrder({orderId:'NEW',orderNo:'YS-NEW',items:[{itemId:'NEW-I',itemName:'新服務'}]});await lookup;
 f.node('serviceOccurredAt').value='2026-10-23T10:00:00';f.node('serviceNewCaseId').value='new-case';f.node('serviceNewQty').value='1';
 f.setSend(async input=>({orderId:input.orderId,itemId:input.itemId}));await f.c.saveServiceCaseAction();
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].orderId,'NEW');assert.equal(f.calls[0].itemId,'NEW-I');
 assert.equal(reads[2].orderId,'NEW');
});
test('read-only order guard allows only the gated service entry while order mutations remain blocked',()=>{
 const bootstrap=fs.readFileSync('src/app/bootstrap.js','utf8');
 const block=bootstrap.slice(bootstrap.indexOf('    const blockReadonlyEdit = event => {'),bootstrap.indexOf("    document.addEventListener('click', blockReadonlyEdit"));
 let enabled=true,handler='openServiceCases()',blocked=0;
 const section={classList:{contains:()=>true}},button={type:'button',tagName:'BUTTON',getAttribute:()=>handler,closest:()=>null};
 const event={type:'click',target:{closest:selector=>selector==='.content-section'?section:button},
  preventDefault:()=>blocked++,stopImmediatePropagation(){}};
 const c=vm.createContext({getActivePermissionPage:()=> 'orders.list',canEditPage:()=>false,
  serviceCaseEntryEnabled:()=>enabled,alert(){}});c.globalThis=c;
 vm.runInContext(block+'\nglobalThis.guard=blockReadonlyEdit;',c);
 c.guard(event);assert.equal(blocked,0);
 handler='saveNewOrder()';c.guard(event);assert.equal(blocked,1);
 handler='openServiceCases()';enabled=false;c.guard(event);assert.equal(blocked,2);
});

test('original order hint uses only authorized case projection, never stored shipment flags, and scopes user session',async()=>{
 const f=fixture();
 const items=[{itemId:'I',itemName:'<檢測>',productType:'SERVICE',deliveredQty:500,isDelivered:true}];
 assert.equal(f.c.serviceCaseVerifiedOrderHints('O',items),'');
 let reads=0;
 f.data.itemProgress.completedQty=1;
 f.data.itemWorkCategory='delivery';
 f.setRead(async()=>{reads++;return f.data;});
 await f.c.openServiceCases('O');
 const hint=f.c.serviceCaseVerifiedOrderHints('O',items);
 assert.match(hint,/上次查核完成 1\/2/);
 assert.match(hint,/待服務處理/);
 assert.match(hint,/&lt;檢測>/);
 assert.doesNotMatch(hint,/500|已核銷/);
 assert.equal(reads,1,'rendering an order hint must not issue extra Firestore/Callable reads');
 assert.equal(f.c.serviceCaseVerifiedOrderHints('OTHER',items),'');
 f.c.currentUserRole='engineer';
 assert.equal(f.c.serviceCaseVerifiedOrderHints('O',items),'');
 f.c.currentUserRole='sales';
 f.c.sessionDataGeneration=2;
 assert.equal(f.c.serviceCaseVerifiedOrderHints('O',items),'');
});
test('a mismatched or unknown backend result cannot become a verified original-list status',async()=>{
 const f=fixture();
 f.data.itemProgress.completedQty=2;
 f.data.itemWorkCategory='billing';
 f.setRead(async()=>({...f.data,orderId:'OTHER'}));
 await f.c.openServiceCases('O');
 assert.equal(f.c.serviceCaseVerifiedOrderHints('O',[{itemId:'I',productType:'SERVICE'}]),'');
 f.c.resetServiceCaseView();
 f.setRead(async()=>({...f.data,orderId:'O',itemWorkCategory:'unverified'}));
 await f.c.openServiceCases('O');
 assert.equal(f.c.serviceCaseVerifiedOrderHints('O',[{itemId:'I',productType:'SERVICE'}]),'');
});

test('explicit whole-service-order progress read populates original order hints without writes',async()=>{
 const f=fixture();await f.c.openServiceCases('O');
 const before=f.calls.length;await f.c.verifyServiceOrderProgress();
 assert.equal(f.calls.length,before);
 assert.match(f.node('serviceOrderSummaryBody').innerHTML,/已完成 1／2/);
 assert.match(f.node('serviceOrderSummaryBody').innerHTML,/不影響核銷/);
 assert.match(f.c.serviceCaseVerifiedOrderHints('O',[{itemId:'I',productType:'SERVICE'}]),/1\/2/);
});
test('whole-order verification rejects foreign item injection and stale selection replies',async()=>{
 const f=fixture();await f.c.openServiceCases('O');
 f.setReadOrder(async()=>({orderId:'O',items:[{itemId:'OTHER',orderedQty:2,completedQty:2,workCategory:'complete'}]}));
 await f.c.verifyServiceOrderProgress();
 assert.match(f.node('serviceOrderSummaryBody').textContent,/不一致/);
 assert.doesNotMatch(f.c.serviceCaseVerifiedOrderHints('O',[{itemId:'I',productType:'SERVICE'}]),/2\/2/);
 let resolve;
 f.setReadOrder(()=>new Promise(r=>resolve=r));
 const old=f.c.verifyServiceOrderProgress();
 await f.c.loadServiceCaseItem('I');
 resolve({orderId:'O',items:[{itemId:'I',orderedQty:2,completedQty:2,workCategory:'complete'}]});
 await old;
 assert.doesNotMatch(f.c.serviceCaseVerifiedOrderHints('O',[{itemId:'I',productType:'SERVICE'}]),/2\/2/);
});

test('partial siblings retain their own verified progress; Goods and unverified items get no hint',async()=>{
 const f=fixture();
 f.c.ordersCache[0].items.push({itemId:'J',productType:'SERVICE',itemName:'校正'});
 await f.c.openServiceCases('O');
 f.setReadOrder(async()=>({orderId:'O',orderedQty:4,completedQty:2,mixedOrder:false,items:[
  {itemId:'I',itemName:'檢測',orderedQty:2,completedQty:2,workCategory:'billing'},
  {itemId:'J',itemName:'校正',orderedQty:2,completedQty:0,workCategory:'delivery'}]}));
 await f.c.verifyServiceOrderProgress();
 const hint=id=>f.c.serviceCaseVerifiedItemHint('O',{itemId:id,productType:'SERVICE'});
 assert.match(hint('I'),/2\/2.*服務完成・待核銷/);
 assert.match(hint('J'),/0\/2.*待服務處理/);
 assert.equal(hint('UNKNOWN'),'');
 assert.equal(f.c.serviceCaseVerifiedItemHint('O',{itemId:'I',productType:'Goods'}),'');
 assert.equal(f.calls.length,0);
});
test('whole-order read coalesces repeated clicks, restores retry after failure and never writes',async()=>{
 const f=fixture();await f.c.openServiceCases('O');let reject,reads=0;
 f.setReadOrder(()=>{reads++;return new Promise((_,r)=>reject=r);});
 const pending=f.c.verifyServiceOrderProgress();await f.c.verifyServiceOrderProgress();
 assert.equal(reads,1);assert.equal(f.node('verifyServiceOrderButton').disabled,true);
 assert.equal(f.node('verifyServiceOrderButton').textContent,'查核中…');
 reject(Error('連線中斷'));await pending;
 assert.match(f.node('serviceOrderSummaryBody').textContent,/查核未完成.*連線中斷/);
 assert.equal(f.node('verifyServiceOrderButton').disabled,false);
 f.setReadOrder(async()=>({orderId:'O',orderedQty:2,completedQty:1,items:[
  {itemId:'I',itemName:'檢測',orderedQty:2,completedQty:1,workCategory:'delivery'}]}));
 await f.c.verifyServiceOrderProgress();
 assert.match(f.node('serviceOrderSummaryBody').innerHTML,/已完成 1／2/);
 assert.equal(f.calls.length,0);
});
test('expired verified progress disappears without changing the authoritative order',async()=>{
 const f=fixture();await f.c.openServiceCases('O');await f.c.verifyServiceOrderProgress();
 const before=JSON.stringify(f.c.ordersCache);
 vm.runInContext('for(const value of verifiedServiceListHints.values())value.readAt-=SERVICE_LIST_HINT_TTL_MS+1;',f.c);
 assert.equal(f.c.serviceCaseVerifiedItemHint('O',{itemId:'I',productType:'SERVICE'}),'');
 assert.equal(JSON.stringify(f.c.ordersCache),before);assert.equal(f.calls.length,0);
});
