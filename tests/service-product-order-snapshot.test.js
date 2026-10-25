'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const priceSource=fs.readFileSync('src/features/analytics/sales-reports.js','utf8');
const orderSource=fs.readFileSync('src/features/orders/order-creation.js','utf8');
const itemCore=require('../modules/order-entry-core.js');
const toPrice=priceSource.slice(priceSource.indexOf('function productMasterDocToPriceItem('),
  priceSource.indexOf('const visibleProductCostCache'));
const toOrder=orderSource.slice(orderSource.indexOf('function normalizeNewOrderItem('),
  orderSource.indexOf('function currentOrderModalItem('));
test('product master Service subtype enters the shared price lookup without another read',()=>{
 const ctx=vm.createContext({normalizeProductMasterItem:x=>x,resolveBrandName:x=>x,
   isBrandPriceListActive:()=>true});
 vm.runInContext(toPrice,ctx);
 const result=vm.runInContext('productMasterDocToPriceItem({id:"P",data:()=>({productId:"P",brandName:"B",manufacturerPartNo:"S",productName:"Sample",productType:"Service",serviceKind:"BIOPLEX_LAB",listPrice:100})})',ctx);
 assert.equal(result.serviceKind,'BIOPLEX_LAB');
 assert.equal(result.productType,'Service');
 assert.equal(result.productId,'P');
});
test('quote/forecast/manual order snapshots copy the same Service kind but no spoofed Goods kind',()=>{
 const master={productId:'P',brand:'B',productType:'Service',serviceKind:'PIPETTE_CALIBRATION'};
 const ctx=vm.createContext({findPriceItemForOrder:()=>master,resolveBrandName:x=>x,
   brandIdForName:()=>'',normalizeHistoryItemCode:x=>x,Math,Date});
 vm.runInContext(toOrder,ctx);
 const fromMaster=vm.runInContext('normalizeNewOrderItem({itemName:"Pipette",qty:2,unitPrice:300,itemCode:"X",productMasterMatched:true})',ctx);
 assert.equal(fromMaster.serviceKind,'PIPETTE_CALIBRATION');
 assert.equal(fromMaster.productType,'Service');
 assert.equal(fromMaster.productId,'P');
 const reloaded=vm.runInContext('normalizeNewOrderItem('+JSON.stringify(fromMaster)+')',ctx);
 assert.equal(reloaded.serviceKind,'PIPETTE_CALIBRATION');
 assert.equal(itemCore.copyItem(fromMaster).serviceKind,'PIPETTE_CALIBRATION');
 ctx.findPriceItemForOrder=()=>null;
 const goods=vm.runInContext('normalizeNewOrderItem({itemName:"Reagent",itemCode:"Y",productType:"Reagent",serviceKind:"ONSITE_REPAIR",qty:1,unitPrice:50})',ctx);
 assert.equal(goods.serviceKind,'');
});
