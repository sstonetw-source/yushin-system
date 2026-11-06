'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function setup(){
 const c=vm.createContext({window:{},YushinSupplier:require('../modules/supplier-core'),escapeHtml:String});
 vm.runInContext(fs.readFileSync('src/shared/workspace-display.js','utf8'),c);
 return c;
}
test('estimated cost uses only the quantity still to purchase and includes tax',()=>{
 const c=setup(),item={itemId:'I',qty:10,unitPrice:2500};
 const amounts=c.purchaseWorkAmounts({items:[item]},item,{qty:4,estimate:true,supplies:[{qty:4,unitCost:1666.65}]});
 assert.equal(amounts.sales,10000);
 assert.equal(amounts.cost,7000);
 assert.equal(amounts.ratio,70);
 assert.match(c.purchaseWorkAmountMarkup(amounts,true),/預估成本率：70%/);
});
test('combined supplies use the sum of the applicable rounded costs',()=>{
 const c=setup(),item={itemId:'I',qty:10,unitPrice:30};
 const supplies=[{qty:3,unitCost:10},{qty:2,unitCost:20}];
 const amounts=c.purchaseWorkAmounts({items:[item]},item,{qty:5,supplies});
 assert.equal(amounts.cost,32+42);
 assert.equal(amounts.sales,150);
 assert.equal(amounts.ratio,74/150*100);
 assert.equal(c.purchaseSupplyCost({unitCost:10},3),32);
 assert.equal(c.purchaseSupplyCost({unitCost:10},2),21);
});
test('missing costs, zero costs, zero sale, and old missing sales prices remain distinct',()=>{
 const c=setup(),item={itemId:'I',unitPrice:200},order={items:[item]};
 const supplies=[{qty:2}];
 const markup=()=>c.purchaseWorkAmountMarkup(c.purchaseWorkAmounts(order,item,{qty:2,supplies}),true);
 assert.match(markup(),/成本待確認[\s\S]*成本率：待確認/);
 supplies[0].unitCost=0;assert.match(markup(),/採購成本：NT\$ 0[\s\S]*成本率：0%/);
 item.unitPrice=0;assert.match(markup(),/成本率：—/);
 delete item.unitPrice;assert.match(markup(),/銷售金額：待確認/);
});
test('stock and services avoid synthetic margins and unauthorized roles get only sales',()=>{
 const c=setup(),item={itemId:'I',unitPrice:200};
 const stock=c.purchaseWorkAmounts(null,{}, {qty:2,stock:true,supplies:[{qty:2,unitCost:100}]});
 assert.match(c.purchaseWorkAmountMarkup(stock,true),/銷售金額：—[\s\S]*採購成本：NT\$ 210[\s\S]*成本率：—/);
 const service=c.purchaseWorkAmounts({items:[item]},item,{qty:2,service:true});
 assert.match(c.purchaseWorkAmountMarkup(service,true),/採購成本：—[\s\S]*成本率：—/);
 assert.doesNotMatch(c.purchaseWorkAmountMarkup(stock,false),/成本/);
});
