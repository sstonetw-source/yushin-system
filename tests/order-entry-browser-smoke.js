/* Browser fixture uses real markup, CSS and entry/delivery handlers; no Firebase session. */
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');const {chromium}=require('playwright-core');const {spawnSync}=require('node:child_process');
const app=fs.readFileSync('app.js','utf8');const html=fs.readFileSync('index.html','utf8');
const slice=(a,b)=>app.slice(app.indexOf(a),app.indexOf(b,app.indexOf(a)));
const modal=html.slice(html.lastIndexOf('    <!-- 新增訂單彈出視窗 -->'),html.indexOf('    <!--',html.indexOf('id="orderModalOverlay"')+1));
const logistics=fs.readFileSync('modules/warehouse-logistics.js','utf8').split("  if(typeof document==='undefined')return;")[0]+'})(globalThis);';
const bootstrap=`
const currentUser={uid:'sales'};let currentUserRole='sales';const salesList=[{uid:'sales',name:'業務',phone:'123',deliveryDefaults:{mode:'PICKUP'}},{uid:'engineer',name:'工程師',phone:'456',deliveryDefaults:{mode:'SALES_SHIP',address:'工程師地址'}}];
const warehouseMasterCache=[{id:'MAIN',isDefault:true}],orderModalOpenGeneration=1;let orderCostRequestGeneration=0;let newOrderDraftItems=[];
const defaultWarehouse=()=>warehouseMasterCache[0],customerIdForName=x=>x,normalizeItemCodeLoose=x=>String(x||'').toLowerCase(),normalizeBrandLookupKey=normalizeItemCodeLoose,resolveBrandName=x=>x,normalizeHistoryItemCode=x=>x,brandIdForName=x=>x,stableProductId=x=>x.productId;
const escapeHtml=x=>String(x||''),escapeAttr=escapeHtml;
const firestoreReadWithTimeout=p=>p,db={collection:()=>({doc:()=>({get:async()=>({exists:false})})})};
const product={productId:'P',model:'A1',brand:'Roche',nameCn:'試劑',nameEn:'Reagent',spec:'96 次',price:100};
const findPriceItemForOrder=item=>item.productId==='P'?product:null,findProductsByCode=async code=>code==='A1'?[product]:[],selectProductCodeMatch=matches=>matches[0]||null;
const clearQuickProductButton=()=>{},clearProductMatchChoices=()=>{},clearProductStockHint=()=>{},setOrderCostFieldForProduct=()=>{},showQuickProductButton=()=>{},showProductMatchChoices=()=>{},queueProductCodeSuggestions=()=>{},queueCustomerMasterSuggestions=()=>{};
const getBrandFieldValue=()=>document.getElementById('orderBrand').value,selectBrandInDropdown=(el,v)=>el.value=v,onOrderBrandSelectChange=()=>{};
const calcOrderTotal=()=>{document.getElementById('orderTotalPrice').value=Number(document.getElementById('orderQty').value)*Number(document.getElementById('orderUnitPrice').value);};
const applyOrderProductCost=async()=>{},refreshOrderWarehouseStock=async()=>{};
window.onOrderFulfillmentChange=()=>refreshOrderWarehouseStock();
window.onOrderProcurementTypeChange=()=>{const self=document.getElementById('orderProcurementType').value==='SALES_SELF_ORDER';document.getElementById('orderSelfSupplierWrap').style.display=self?'':'none';document.getElementById('orderCostFieldWrap').style.display=self?'':'none';};
window.alerts=[];window.alert=x=>window.alerts.push(x);window.closeOrderModal=()=>{};window.addCurrentOrderItemToDraft=()=>{};
window.newOrderSaveInProgress=false;const assertOrderItemCount=()=>{};const isSelectableCommercialOwner=()=>true;
window.editNewOrderDraftItem=()=>{};
window.setOrderShippingInstructions=function(p={}){const host=document.getElementById('orderShippingFields');host.innerHTML='<div class="form-grid"><label>交付方式<select id="orderShippingMode"><option value="PICKUP">主倉自領</option><option value="SALES_SHIP">寄給負責業務</option><option value="CUSTOMER_SHIP">直接寄客戶</option></select></label><label>倉庫<select id="orderShippingWarehouse"><option value="MAIN">主倉</option></select></label>'+['Contact','Phone','Address','Notes'].map((key,i)=>'<label>'+['收件人','電話','地址','備註'][i]+'<input id="orderShipping'+key+'"></label>').join('')+'</div>';document.getElementById('orderShippingMode').value=p.mode||'PICKUP';for(const key of ['Contact','Phone','Address','Notes'])document.getElementById('orderShipping'+key).value=p[key.toLowerCase()]||'';};
`;
const save=slice('window.saveNewOrder = function()','    items.forEach(item=>{delete item.productCheckStatus;});')+'window.validated={items,shippingInstructions};return window.validated;};';
(async()=>{
 const executablePath=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','google-chrome-stable','chromium'].map(name=>spawnSync('which',[name],{encoding:'utf8'})).find(r=>r.status===0)?.stdout.trim();
 assert.ok(executablePath,'Headless Chrome is required');
 const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-dev-shm-usage']});
 const errors=[];
 const fontPath=process.env.ORDER_ENTRY_FONT;const fontStyle=fontPath?`@font-face{font-family:EntryTC;src:url(data:font/otf;base64,${fs.readFileSync(fontPath).toString('base64')})}body,input,select,button,textarea{font-family:EntryTC,sans-serif!important}`:'';
 try{
  for(const width of [1280,390]){
   const page=await browser.newPage({viewport:{width,height:1000}});page.on('pageerror',e=>errors.push(e.message));
   await page.setContent('<html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="appContainer">'+modal+'</div></body></html>');
   await page.addStyleTag({content:fs.readFileSync('styles.css','utf8')+fontStyle});
   for(const content of [logistics,fs.readFileSync('modules/order-entry-core.js','utf8'),bootstrap,
    slice('function clearOrderProductIdentityKeepBrand(', 'window.onOrderBrandSelectChange'),slice('function clearOrderProductMatch(', '// 客戶名稱自動完成'),
    slice('function normalizeNewOrderItem(', 'let orderDraftProductCheckGeneration'),save,
    fs.readFileSync('modules/order-self-order-required.js','utf8'),fs.readFileSync('modules/delivery-settings.js','utf8'),fs.readFileSync('modules/order-entry-ui.js','utf8')])await page.addScriptTag({content});
   await page.evaluate(()=>{document.getElementById('orderModalOverlay').classList.add('active');document.getElementById('orderBrand').innerHTML='<option></option><option>Roche</option>';initializeOrderDeliveryDefaults();document.getElementById('orderWarehouse').value='MAIN';document.getElementById('orderDateInput').value='2026-10-13';});
   await page.locator('#orderCustomer').fill('台大');await page.locator('#orderItemCode').fill('A1');await page.waitForFunction(()=>document.getElementById('orderItemCode').dataset.productCheckStatus==='matched');
   assert.equal(await page.locator('#orderUnitPrice').inputValue(),'100');assert.equal(await page.locator('#orderProductDetails').getAttribute('open'),null);
   assert.match(await page.locator('#orderEntryProductSummary').textContent(),/試劑/);
   await page.locator('#saveNewOrderBtn').click();assert.match(await page.evaluate(()=>alerts.at(-1)),/交易方式/);
   await page.locator('#orderTransactionType').selectOption('借');
   await page.locator('#saveNewOrderBtn').click();assert.equal(await page.evaluate(()=>validated.shippingInstructions.mode),'PICKUP');
   await page.evaluate(()=>{document.getElementById('orderModalOverlay').scrollTop=0;});
   await page.screenshot({path:path.join(process.env.ORDER_ENTRY_SCREENSHOT_DIR||'/tmp',`order-entry-default-${width}.png`),fullPage:true});
   await page.locator('#orderProcurementType').selectOption('SALES_SELF_ORDER');assert.equal(await page.locator('#orderSelfStatusWrap').isVisible(),true);
   assert.equal(await page.locator('select#orderSelfOrderConfirmed, #orderSelfOrderConfirmed option').count(),0);
   assert.equal(await page.locator('#orderSelfOrderConfirmed').inputValue(),'confirmed');
   await page.locator('#orderCostPrice').fill('');await page.locator('#orderSelfSupplier').fill('');await page.locator('#saveNewOrderBtn').click();assert.equal(await page.locator('#orderSelfSupplier').evaluate(el=>el.validationMessage.length>0),true);
   await page.locator('#orderSelfSupplier').fill('Vendor');await page.locator('#orderCostPrice').fill('0');await page.locator('#saveNewOrderBtn').click();assert.equal(await page.evaluate(()=>validated.items[0].costPrice),0);assert.equal(await page.evaluate(()=>validated.items[0].selfOrderConfirmed),true);
   await page.locator('#orderDeliveryChoice').selectOption('DIRECT');await page.locator('#saveNewOrderBtn').click();assert.match(await page.evaluate(()=>alerts.at(-1)),/收件/);
   assert.equal(await page.locator('#orderRecipientDetails').isVisible(),true);
   await page.locator('#orderShippingContact').fill('客戶');await page.locator('#orderShippingPhone').fill('123');await page.locator('#orderShippingAddress').fill('台北市測試地址');await page.locator('#saveNewOrderBtn').click();
   assert.equal(await page.evaluate(()=>validated.items[0].fulfillmentType),'DIRECT_SHIP');assert.equal(await page.evaluate(()=>validated.items[0].deliveryPlan.contact),'客戶');
   await page.evaluate(()=>{newOrderDraftItems=[currentOrderModalItem(),{...currentOrderModalItem(),itemId:'OTHER'}];renderNewOrderDraftItems();});
   const dimensions=await page.evaluate(()=>{const box=document.querySelector('#orderModalOverlay .eq-modal-box');return {box:box.clientWidth,scroll:box.scrollWidth,button:document.getElementById('saveNewOrderBtn').getBoundingClientRect().height};});assert.ok(dimensions.scroll<=dimensions.box+1,JSON.stringify(dimensions));assert.ok(dimensions.button>=44);
   await page.evaluate(()=>{document.getElementById('orderModalOverlay').scrollTop=0;});
   await page.screenshot({path:path.join(process.env.ORDER_ENTRY_SCREENSHOT_DIR||'/tmp',`order-entry-${width}.png`),fullPage:true});
   for(const role of ['sales','engineer','admin','purchaser']){await page.evaluate(role=>{currentUserRole=role;syncOrderEntrySelfStatus();},role);assert.equal(await page.locator('#orderSelfOrderConfirmed').isDisabled(),role==='purchaser');assert.equal(await page.locator('#orderSelfOrderConfirmed').inputValue(),role==='purchaser'?'pending':'confirmed');}
   console.log(`Browser ${width}px: product lookup, automatic confirmed self-order and purchaser authority, direct shipment recipient and layout passed.`);
   await page.close();
  }
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
