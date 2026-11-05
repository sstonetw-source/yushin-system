'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function setup(){
 const c=vm.createContext({window:{},YushinSupplier:require('../modules/supplier-core'),currentUserRole:'purchaser',escapeHtml:String,supplyReceivingCache:[],purchaseHistorySupplyCache:new Map(),isPurchaseTerminalStatus:status=>status==='CANCELLED'});
 vm.runInContext(fs.readFileSync('src/shared/workspace-display.js','utf8'),c);
 return c;
}
test('cost ratio compares the purchased quantity at tax-inclusive cost and sale price',()=>{
 const c=setup();c.supplyReceivingCache=[{id:'S',orderId:'O',itemId:'I',qty:2,unitCost:100}];
 const html=c.purchasingFinancialSummary({id:'O'},{itemId:'I',qty:10,unitPrice:210});
 assert.match(html,/NT\$ 210/);assert.match(html,/NT\$ 420/);assert.match(html,/50%/);assert.match(html,/預估/);assert.match(html,/比較數量：2/);
});
test('missing costs never become zero, while valid zero cost and zero sale are handled explicitly',()=>{
 const c=setup(),s={id:'S',orderId:'O',itemId:'I',qty:2};c.supplyReceivingCache=[s];
 assert.match(c.purchasingFinancialSummary({id:'O'},{itemId:'I',unitPrice:200}),/待確認/);
 s.unitCost=0;assert.match(c.purchasingFinancialSummary({id:'O'},{itemId:'I',unitPrice:200}),/成本率：0%/);
 assert.match(c.purchasingFinancialSummary({id:'O'},{itemId:'I',unitPrice:0}),/成本率：—/);
});
test('stock purchases display only cost and unauthorized roles receive no financial markup',()=>{
 const c=setup(),s={qty:2,unitCost:100};
 const html=c.purchasingFinancialSummary(null,s,[s]);assert.match(html,/銷售金額（含稅）：—/);assert.match(html,/成本率：—/);
 for(const role of ['warehouse','sales','engineer']){c.currentUserRole=role;assert.equal(c.purchasingFinancialSummary(null,s,[s]),'');}
});

test('tax-inclusive comparison preserves the existing purchase document rounding',()=>{
 const c=setup();c.supplyReceivingCache=[{id:'S',orderId:'O',itemId:'I',qty:1,unitCost:100.49}];
 const html=c.purchasingFinancialSummary({id:'O'},{itemId:'I',unitPrice:210});
 assert.match(html,/NT\$ 105/);assert.match(html,/50%/);assert.doesNotMatch(html,/105\.51/);
});
