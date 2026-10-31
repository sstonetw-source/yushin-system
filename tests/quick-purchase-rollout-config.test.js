'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const rollout=fs.readFileSync(path.join(root,'transaction-rollout-config.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const version='20261031-order-res-1';

test('reviewed production transaction flags are always disabled by default',()=>{
 const context={YUSHIN_PRODUCTION_QUICK_PURCHASE:true,YUSHIN_PREVIEW_QUICK_PURCHASE:true,
  YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND:true,
  YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED:true};
 context.globalThis=context;
 vm.runInNewContext(rollout,context,{filename:'transaction-rollout-config.js'});
 assert.equal(context.YUSHIN_PRODUCTION_QUICK_PURCHASE,false);
 assert.equal(context.YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND,false);
 assert.equal(context.YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED,false);
 assert.equal(context.YUSHIN_PRODUCTION_QUICK_PURCHASE_CONFIG_VERSION,version);
 assert.equal(context.YUSHIN_PREVIEW_QUICK_PURCHASE,true,'the production rollout must not mutate Preview controls');
 vm.runInNewContext(rollout,context);
 assert.equal(context.YUSHIN_PRODUCTION_QUICK_PURCHASE,false,'reloading the asset must remain fail-closed');
 assert.equal(context.YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND,false,'reservation flag must remain fail-closed');
 assert.equal(context.YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED,false,'untrusted origins must not inherit a production flag');
});

test('versioned rollout config loads synchronously before generated app.js',()=>{
 const configMatch=html.match(/<script src="transaction-rollout-config\.js\?v=([^"]+)"\s*><\/script>/);
 assert.ok(configMatch,'index.html must include the reviewed local rollout config');
 assert.equal(configMatch[1],version,'asset version and contents must be advanced together');
 const configTag=configMatch[0],configIndex=html.indexOf(configTag),appIndex=html.indexOf('<script src="app.js?');
 assert.ok(configIndex>=0&&appIndex>configIndex,'config must execute before app.js');
 assert.doesNotMatch(configTag,/\b(?:async|defer)\b/,'rollout config must not race app.js');
 assert.match(rollout,/YUSHIN_PRODUCTION_QUICK_PURCHASE\s*=\s*false\s*;/);
 assert.match(rollout,/YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND\s*=\s*orderReservationProductionSite\s*;/);
 assert.match(rollout,/YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED\s*=\s*orderReservationProductionSite\s*;/);
 assert.doesNotMatch(rollout,/YUSHIN_PRODUCTION_QUICK_PURCHASE\s*=\s*true\s*;/);
 assert.doesNotMatch(rollout,/YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND\s*=\s*true\s*;/);
});

test('approved production order activation is restricted to the exact HTTPS Pages origin and repository path',()=>{
 for(const url of ['https://sstonetw-source.github.io/yushin-system','https://sstonetw-source.github.io/yushin-system/','https://sstonetw-source.github.io/yushin-system/index.html']){
  const parsed=new URL(url),context={location:parsed};context.globalThis=context;
  vm.runInNewContext(rollout,context);
  assert.equal(context.YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND,true,url);
  assert.equal(context.YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED,true,url);
  assert.equal(context.YUSHIN_PRODUCTION_FORMAL_PURCHASE,true,url);
  assert.equal(context.YUSHIN_PRODUCTION_QUICK_PURCHASE,false,url);
  vm.runInNewContext(rollout,context);
  assert.equal(context.YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED,true,'reloading never revives legacy initialization');
 }
 for(const url of ['http://sstonetw-source.github.io/yushin-system/','https://sstonetw-source.github.io:8443/yushin-system/','https://sstonetw-source.github.io/yushin-system-evil/','https://sstonetw-source.github.io/other/','https://evil.example/yushin-system/','https://sstonetw-source.github.io.evil.example/yushin-system/','https://yu-shing-company.web.app/','https://yu-shing-company.firebaseapp.com/','http://localhost:8080/yushin-system/']){
  const context={location:new URL(url),YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND:true,YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED:true};context.globalThis=context;
  vm.runInNewContext(rollout,context);
  assert.equal(context.YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND,false,url);
  assert.equal(context.YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED,false,url);
  assert.equal(context.YUSHIN_PRODUCTION_QUICK_PURCHASE,false,url);
 }
});

test('reviewed production environment keeps formal purchasing enabled and other migrations closed',()=>{
 const lines=fs.readFileSync(path.join(root,'functions/.env.yu-shing-company'),'utf8').trim().split('\n');
 assert.deepEqual(Object.fromEntries(lines.map(line=>line.split('='))),{
  ENABLE_ORDER_RESERVATION_BACKEND:'true',ENABLE_PRODUCTION_ORDER_RESERVATION_BACKEND:'true',ENABLE_PRODUCTION_FORMAL_PURCHASE:'true'
 });
 assert.match(html,/<script src="app\.js\?v=20261031-415"/);
});
