'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright-core'),{spawnSync}=require('node:child_process');
const src=fs.readFileSync('app.js','utf8');
function fn(name){const start=src.indexOf('function '+name+'(');assert.ok(start>=0,name);return src.slice(start,src.indexOf('\n}',start)+2);}
(async()=>{
 const executablePath=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','google-chrome-stable','chromium'].map(x=>spawnSync('which',[x],{encoding:'utf8'})).find(x=>x.status===0)?.stdout.trim();
 assert.ok(executablePath,'Chrome required');const browser=await chromium.launch({executablePath,args:['--no-sandbox']});
 try{for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<html lang="zh-Hant"><meta name="viewport" content="width=device-width,initial-scale=1"><main><h2>負責人驗收</h2><label for="salesName">估價單負責人</label><select id="salesName" onchange="updateSalesPhoneDisplay()"></select><span id="salesPhone"></span><div id="orderOwnerWrap"><label for="orderOwnerUid">訂單負責人</label><select id="orderOwnerUid"></select></div><label for="eqSales">儀器負責人</label><select id="eqSales"></select></main></html>');
  await page.addStyleTag({content:fs.readFileSync('styles.css','utf8')});
  await page.addScriptTag({content:`
   let currentUserRole='admin',currentUser={uid:'B1'},currentUserName='同名主管',currentUserCode='M1',currentUserPhone='111',editingQuoteNo='',restoringQuoteDraft=false,loadedQuoteOwnerIdentity=null,requestedOrderOwnerUid='';
   const salesList=[{uid:'B1',name:'同名主管',code:'M1',role:'admin',phone:'111'},{uid:'B2',name:'同名主管',code:'M2',role:'admin',phone:'222'},{uid:'S',name:'業務',code:'S1',role:'sales'},{uid:'E',name:'工程師',code:'E1',role:'engineer'},{uid:'A',name:'純管理',code:'',role:'admin'},{uid:'OFF',name:'停用',code:'X',role:'sales',disabled:true}];
   function canViewAllEquipment(){return ['admin','engineer'].includes(currentUserRole);}
   const ROLE_LABELS={admin:'管理員',sales:'業務',engineer:'工程師'};function generateQuoteNo(){};
  `});
  await page.addScriptTag({content:['isSelectableCommercialOwner','quotePersonFromIdentity','quoteOwnerFromSelection','setQuoteOwnerSelection','populateSalesDropdown','updateSalesPhoneDisplay','populateOrderOwnerSelect','equipmentOwnerFromSelection','setEquipmentOwnerSelection','populateEquipmentSalesDropdown'].map(fn).join('\n')});
  await page.evaluate(()=>{populateSalesDropdown();populateOrderOwnerSelect();});
  assert.deepEqual(await page.locator('#salesName option').evaluateAll(rows=>rows.map(x=>x.value)),['','B1','B2','S','E']);
  await page.getByLabel('估價單負責人',{exact:true}).selectOption('B2');
  assert.deepEqual(await page.evaluate(()=>quoteOwnerFromSelection()),{ownerUid:'B2',salesCode:'M2',salesName:'同名主管'});
  assert.equal(await page.locator('#salesPhone').innerText(),'222');
  assert.equal(await page.getByLabel('訂單負責人',{exact:true}).inputValue(),'B1');
  await page.getByLabel('訂單負責人',{exact:true}).selectOption('S');assert.equal(await page.getByLabel('訂單負責人',{exact:true}).inputValue(),'S');
  await page.evaluate(()=>{currentUserRole='engineer';currentUser={uid:'E'};currentUserName='工程師';currentUserCode='E1';document.getElementById('salesName').value='';populateSalesDropdown();populateOrderOwnerSelect();});
  assert.deepEqual(await page.locator('#salesName option').evaluateAll(rows=>rows.map(x=>x.value)),['','E']);
  assert.equal(await page.locator('#orderOwnerWrap').isVisible(),false);
  assert.equal(await page.evaluate(()=>quoteOwnerFromSelection().ownerUid),'E');
  await page.evaluate(()=>populateEquipmentSalesDropdown());
  await page.getByLabel('儀器負責人',{exact:true}).selectOption('B2');
  assert.deepEqual(await page.evaluate(()=>equipmentOwnerFromSelection()),{ownerUid:'B2',salesCode:'M2',salesName:'同名主管'});
  await page.evaluate(()=>{setEquipmentOwnerSelection({salesName:'歷史負責人',salesCode:'OLD'});populateEquipmentSalesDropdown();});
  assert.deepEqual(await page.evaluate(()=>equipmentOwnerFromSelection()),{salesCode:'OLD',salesName:'歷史負責人'});
  assert.equal(await page.getByLabel('儀器負責人',{exact:true}).inputValue(),'historical-equipment');
  assert.deepEqual(errors,[]);await page.close();console.log('Commercial owner '+width+'px passed');
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
