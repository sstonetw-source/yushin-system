'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const rollout=fs.readFileSync(path.join(root,'transaction-rollout-config.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const version='20261110-stock-retirement-4';

test('missing production origin leaves all new transaction flags disabled',()=>{
 const context={YUSHIN_PRODUCTION_QUICK_PURCHASE_LEGACY_BLOCKED:true,YUSHIN_PRODUCTION_QUICK_PURCHASE:true,YUSHIN_PREVIEW_QUICK_PURCHASE:true,
  YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND:true,
  YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED:true};
 context.globalThis=context;
 vm.runInNewContext(rollout,context,{filename:'transaction-rollout-config.js'});
 assert.equal(context.YUSHIN_PRODUCTION_QUICK_PURCHASE,false);
 assert.equal(context.YUSHIN_PRODUCTION_QUICK_PURCHASE_LEGACY_BLOCKED,false);
 assert.equal(context.YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND,false);
 assert.equal(context.YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED,false);
 assert.equal(context.YUSHIN_PRODUCTION_QUICK_PURCHASE_CONFIG_VERSION,version);
 assert.equal(context.YUSHIN_PREVIEW_QUICK_PURCHASE,true,'the production rollout must not mutate Preview controls');
 vm.runInNewContext(rollout,context);
 assert.equal(context.YUSHIN_PRODUCTION_QUICK_PURCHASE,false,'reloading the asset must remain fail-closed');
 assert.equal(context.YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND,false,'reservation flag must remain fail-closed');
 assert.equal(context.YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED,false,'untrusted origins must not inherit a production flag');
});

test('receiving cutover and retirement lock follow only the approved production site',()=>{
 for(const url of ['https://sstonetw-source.github.io/yushin-system/','https://evil.example/yushin-system/']){
  const context={location:new URL(url),YUSHIN_PRODUCTION_RECEIVING_BACKEND:true,
   YUSHIN_PRODUCTION_RECEIVING_LEGACY_BLOCKED:true,YUSHIN_PREVIEW_RECEIVING:true};
  context.globalThis=context;
  vm.runInNewContext(rollout,context);
  assert.equal(context.YUSHIN_PRODUCTION_RECEIVING_BACKEND,url==='https://sstonetw-source.github.io/yushin-system/',url);
  assert.equal(context.YUSHIN_PRODUCTION_RECEIVING_LEGACY_BLOCKED,url==='https://sstonetw-source.github.io/yushin-system/',url);
  assert.equal(context.YUSHIN_PREVIEW_RECEIVING,true,'production config must not change Preview gates');
  context.YUSHIN_PRODUCTION_RECEIVING_BACKEND=true;
  context.YUSHIN_PRODUCTION_RECEIVING_LEGACY_BLOCKED=true;
  vm.runInNewContext(rollout,context);
  assert.equal(context.YUSHIN_PRODUCTION_RECEIVING_BACKEND,url==='https://sstonetw-source.github.io/yushin-system/','reload follows approved site');
  assert.equal(context.YUSHIN_PRODUCTION_RECEIVING_LEGACY_BLOCKED,url==='https://sstonetw-source.github.io/yushin-system/','reload never revives retired writers on the approved site');
 }
});

test('versioned rollout config loads synchronously before generated app.js',()=>{
 const configMatch=html.match(/<script src="transaction-rollout-config\.js\?v=([^"]+)"\s*><\/script>/);
 assert.ok(configMatch,'index.html must include the reviewed local rollout config');
 assert.equal(configMatch[1],version,'asset version and contents must be advanced together');
 const configTag=configMatch[0],configIndex=html.indexOf(configTag),appIndex=html.indexOf('<script src="app.js?');
 assert.ok(configIndex>=0&&appIndex>configIndex,'config must execute before app.js');
 assert.doesNotMatch(configTag,/\b(?:async|defer)\b/,'rollout config must not race app.js');
 assert.match(rollout,/YUSHIN_PRODUCTION_QUICK_PURCHASE\s*=\s*orderReservationProductionSite\s*;/);
 assert.match(rollout,/YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND\s*=\s*orderReservationProductionSite\s*;/);
 assert.match(rollout,/YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED\s*=\s*orderReservationProductionSite\s*;/);
 assert.doesNotMatch(rollout,/YUSHIN_PRODUCTION_QUICK_PURCHASE\s*=\s*true\s*;/);
 assert.doesNotMatch(rollout,/YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND\s*=\s*true\s*;/);
});

test('approved production transaction activation is restricted to the exact HTTPS Pages origin and repository path',()=>{
 for(const url of ['https://sstonetw-source.github.io/yushin-system','https://sstonetw-source.github.io/yushin-system/','https://sstonetw-source.github.io/yushin-system/index.html']){
  const parsed=new URL(url),context={location:parsed};context.globalThis=context;
  vm.runInNewContext(rollout,context);
  assert.equal(context.YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND,true,url);
  assert.equal(context.YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED,true,url);
  assert.equal(context.YUSHIN_PRODUCTION_FORMAL_PURCHASE,true,url);
  assert.equal(context.YUSHIN_PRODUCTION_SERVICE_CASE_BACKEND,true,url);
  assert.equal(context.YUSHIN_PRODUCTION_QUICK_PURCHASE,true,url);
  assert.equal(context.YUSHIN_PRODUCTION_QUICK_PURCHASE_LEGACY_BLOCKED,true,url);
  vm.runInNewContext(rollout,context);
  assert.equal(context.YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED,true,'reloading never revives legacy initialization');
  assert.equal(context.YUSHIN_PRODUCTION_QUICK_PURCHASE_LEGACY_BLOCKED,true,'reloading retains quick purchase retirement');
 }
 for(const url of ['http://sstonetw-source.github.io/yushin-system/','https://sstonetw-source.github.io:8443/yushin-system/','https://sstonetw-source.github.io/yushin-system-evil/','https://sstonetw-source.github.io/other/','https://evil.example/yushin-system/','https://sstonetw-source.github.io.evil.example/yushin-system/','https://yu-shing-company.web.app/','https://yu-shing-company.firebaseapp.com/','http://localhost:8080/yushin-system/']){
  const context={location:new URL(url),YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND:true,YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED:true};context.globalThis=context;
  vm.runInNewContext(rollout,context);
  assert.equal(context.YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND,false,url);
  assert.equal(context.YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED,false,url);
  assert.equal(context.YUSHIN_PRODUCTION_QUICK_PURCHASE,false,url);
  assert.equal(context.YUSHIN_PRODUCTION_SERVICE_CASE_BACKEND,false,url);
  assert.equal(context.YUSHIN_PRODUCTION_QUICK_PURCHASE_LEGACY_BLOCKED,false,url);
  assert.equal(context.YUSHIN_PRODUCTION_FORMAL_PURCHASE,false,url);
 }
});

test('authorized environment enables production transaction gates without enabling Preview or Emulator',()=>{
 const lines=fs.readFileSync(path.join(root,'functions/.env.yu-shing-company'),'utf8').trim().split('\n');
 const flags=Object.fromEntries(lines.map(line=>line.split('=')));
 const pendingIndependentApproval=new Set([
  'ENABLE_PRODUCTION_SUPPLY_CANCELLATION_BACKEND',
  'ENABLE_PRODUCTION_MAIN_TRANSFER_REQUEST_BACKEND',
  'ENABLE_PRODUCTION_MAIN_TRANSFER_DISPATCH_BACKEND',
  'ENABLE_PRODUCTION_MAIN_TRANSFER_RECEIPT_BACKEND',
  'ENABLE_PRODUCTION_MAIN_TRANSFER_ALLOCATION_BACKEND',
  'ENABLE_PRODUCTION_MANUAL_INVENTORY_BACKEND',
  'ENABLE_PRODUCTION_INVENTORY_COUNT_BACKEND',
  'ENABLE_PRODUCTION_SELF_ORDER_BACKEND'
 ]);
 assert.ok(Object.keys(flags).length>=12);
 for(const [key,value] of Object.entries(flags))assert.equal(value,
  !pendingIndependentApproval.has(key)&&(key==='ENABLE_ORDER_RESERVATION_BACKEND'||key.startsWith('ENABLE_PRODUCTION_'))?'true':'false',key);
 assert.equal(flags.ENABLE_PRODUCTION_ORDER_RESERVATION_BACKEND,'true');
 assert.equal(flags.ENABLE_PRODUCTION_FORMAL_PURCHASE,'true');
 assert.equal(flags.ENABLE_PRODUCTION_QUICK_PURCHASE,'true');
 for(const key of pendingIndependentApproval)assert.equal(flags[key],'false',key+' must remain closed until D approval');
 assert.match(html,/<script src="app\.js\?v=\d{8}-\d+"/);
});

test('all new backend retirement routes are restricted to the approved origin without a maintenance lock',()=>{
 for(const url of ['https://sstonetw-source.github.io/yushin-system','https://sstonetw-source.github.io/yushin-system/','https://sstonetw-source.github.io/yushin-system/index.html','http://localhost:8080/','https://evil.example/yushin-system/']){
  const c={location:new URL(url)};c.globalThis=c;vm.runInNewContext(rollout,c);
  const approved=url.startsWith('https://sstonetw-source.github.io/yushin-system');
  assert.equal(c.YUSHIN_PRODUCTION_MAINTENANCE,undefined);
  for(const name of ['RECEIVING','DISPATCH','SHIPMENT','ORDER_LIFECYCLE','DELIVERY_CONFIRMATION','DELIVERY_REVERSAL','CUSTOMER_RETURN','CUSTOMER_RETURN_REQUEST']){
   assert.equal(c['YUSHIN_PRODUCTION_'+name+'_BACKEND'],approved,name);
   assert.equal(c['YUSHIN_PRODUCTION_'+name+'_LEGACY_BLOCKED'],approved,name);
  }
 }
 assert.doesNotMatch(html,/production-maintenance-redirect|maintenance\.html/);
});
test('unreleased stock-changing backend routes fail closed on Pages without silently enabling a Callable',()=>{
 for(const url of ['https://sstonetw-source.github.io/yushin-system/', 'https://evil.example/yushin-system/']){
  const c={location:new URL(url)};c.globalThis=c;vm.runInNewContext(rollout,c);
  const approved=url.startsWith('https://sstonetw-source.github.io/yushin-system');
  for(const name of ['CANCELLED_PURCHASE','SUPPLY_CANCELLATION','MAIN_TRANSFER_REQUEST','MAIN_TRANSFER_DISPATCH',
   'MAIN_TRANSFER_RECEIPT','MAIN_TRANSFER_ALLOCATION','ORDER_TRANSFER_DISPATCH',
   'ORDER_TRANSFER_HANDOFF','ORDER_TRANSFER_RECEIVE','MANUAL_INVENTORY','INVENTORY_COUNT']){
   assert.equal(c['YUSHIN_PRODUCTION_'+name+'_BACKEND'],false,name);
   assert.equal(c['YUSHIN_PRODUCTION_'+name+'_LEGACY_BLOCKED'],approved,name);
  }
 }
});
