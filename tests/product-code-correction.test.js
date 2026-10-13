const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('app.js','utf8');
const section = (a,b) => source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
function setup() {
    const nodes = {};
    const node = key => nodes[key] ||= {value:'',dataset:{},hidden:true};
    const rows = () => {
        const fields = {};
        const row = {isConnected:true,querySelector:key=>fields[key] ||= {value:'',dataset:{}}};
        const input = row.querySelector('.item-model'); input.closest=()=>row;
        return {row,input};
    };
    const products = [
        {model:'A',productId:'a',brand:'Alpha',nameCn:'甲',nameEn:'A name',spec:'old spec',price:100},
        {model:'B',productId:'b',brand:'Beta',nameCn:'乙',nameEn:'B name',spec:'new spec',price:200},
        {model:'C',productId:'c',brand:'Beta',nameCn:'丙'}
    ];
    const c=vm.createContext({window:{},document:{getElementById:node},setTimeout,clearTimeout,
        normalizeItemCodeLoose:x=>String(x||'').toLowerCase(),normalizeBrandLookupKey:x=>String(x||'').toLowerCase(),resolveBrandName:x=>x,
        getBrandFieldValue:()=>node('orderBrand').value,quoteRowBrandValue:row=>row.querySelector('.item-brand').value,
        onOrderBrandSelectChange(){},onQuoteBrandSelectChange(){},selectBrandInDropdown:(el,v)=>el.value=v,
        clearQuickProductButton(){},clearProductMatchChoices(){},clearProductStockHint(){},setOrderCostFieldForProduct(){},
        calcOrderTotal(){},calculateTotals(){},renderNewOrderDraftItems(){},queueProductCodeSuggestions(){},
        applyOrderProductCost:async()=>{},refreshOrderWarehouseStock:async()=>{},refreshQuoteWarehouseStock(){},
        onIncPriceChange:el=>el.value,stableProductId:p=>p.productId,brandIdForName:x=>x,
        orderModalOpenGeneration:1,orderCostRequestGeneration:0,
        showProductMatchChoices:input=>input.ambiguous=true,showQuickProductButton:input=>input.missing=true,
        findProductsByCode:async code=>products.filter(p=>p.model===code),
        selectProductCodeMatch:(matches,brand)=>{const list=matches.filter(p=>!brand||p.brand===brand);return list.length===1?list[0]:null;}});
    vm.runInContext(section('function clearOrderProductIdentityKeepBrand(', 'window.onOrderBrandSelectChange'),c);
    vm.runInContext(section('function clearOrderProductMatch(', '// 客戶名稱自動完成'),c);
    vm.runInContext(section('const quoteProductChecks =', 'window.onIncPriceChange'),c);
    vm.runInContext(section('function applyQuoteProductMatch(', 'function stableProductId'),c);
    c.onOrderItemCodeChange=c.window.onOrderItemCodeChange;c.onItemModelChange=c.window.onItemModelChange;
    return {c,node,rows,products};
}
test('quote correction across brands updates names, specification, price and identity; missing values clear old data',async()=>{
    const {c,rows}=setup();const {row,input}=rows();input.value='A';
    await c.window.onItemModelChange(input);assert.equal(row.querySelector('.item-spec').value,'old spec');
    input.value='B';await c.window.onItemModelChange(input);
    for(const [key,value] of Object.entries({'.item-cn':'乙','.item-en':'B name','.item-spec':'new spec','.inc-price':200,'.item-product-id':'b','.item-brand':'Beta'}))assert.equal(row.querySelector(key).value,value);
    input.value='C';await c.window.onItemModelChange(input);
    assert.equal(row.querySelector('.item-spec').value,'');assert.equal(row.querySelector('.inc-price').value,'');
});
test('order correction across brands replaces product fields and never preserves old quote price for a new code',async()=>{
    const {c,node}=setup();const input=node('orderItemCode');input.value='A';
    await c.window.onOrderItemCodeChange(input);input.dataset.preserveOrderPriceCode='a';
    node('orderUnitPrice').value=999;input.value='B';await c.window.onOrderItemCodeChange(input);
    assert.equal(node('orderItemName').value,'乙');assert.equal(node('orderSpec').value,'new spec');
    assert.equal(node('orderUnitPrice').value,200);assert.equal(c.window._orderModalProductId,'b');
    input.value='C';await c.window.onOrderItemCodeChange(input);assert.equal(node('orderUnitPrice').value,'');
});
test('unknown or blank corrected code removes previous details and product identity in both forms',async()=>{
    for(const mode of ['quote','order']) {
        const {c,node,rows}=setup();const {row,input:quote}=rows();const input=mode==='quote'?quote:node('orderItemCode');
        const lookup=mode==='quote'?c.window.onItemModelChange:c.window.onOrderItemCodeChange;
        input.value='A';await lookup(input);input.value='unknown';await lookup(input);
        assert.equal(mode==='quote'?row.querySelector('.item-cn').value:node('orderItemName').value,'');
        assert.equal(mode==='quote'?row.querySelector('.item-product-id').value:c.window._orderModalProductId,'');
        input.value='A';await lookup(input);input.value='';await lookup(input);
        assert.equal(mode==='quote'?row.querySelector('.item-spec').value:node('orderSpec').value,'');
    }
});
test('manually selected brand remains a lookup constraint',async()=>{
    const {c,rows}=setup();const {row,input}=rows();row.querySelector('.item-brand').value='Alpha';
    input.value='A';await c.window.onItemModelChange(input);assert.equal(input.dataset.autofillBrand,undefined);
    input.value='B';await c.window.onItemModelChange(input);
    assert.equal(row.querySelector('.item-brand').value,'Alpha');assert.equal(row.querySelector('.item-product-id').value,'');
});
test('latest quote request wins even when a user changes A to B back to A',async()=>{
    const {c,rows,products}=setup();const {row,input}=rows();const pending=[];
    c.findProductsByCode=code=>new Promise(resolve=>pending.push({code,resolve}));
    input.value='A';const first=c.window.onItemModelChange(input);
    input.value='B';const second=c.window.onItemModelChange(input);
    input.value='A';const third=c.window.onItemModelChange(input);
    pending[2].resolve([{...products[0],nameCn:'最新甲'}]);await third;
    pending[0].resolve([products[0]]);pending[1].resolve([products[1]]);await Promise.all([first,second]);
    assert.equal(row.querySelector('.item-cn').value,'最新甲');
});
test('pending order cost is invalidated when code changes',()=>{
    const {c,node}=setup();const input=node('orderItemCode');input.dataset.matchedProductCode='a';input.value='B';
    node('orderCostPrice').value=50;node('orderCostPrice').dataset.autofillCost='50';
    c.clearChangedProductDetails(input,'order');assert.equal(c.orderCostRequestGeneration,1);
    assert.equal(node('orderCostPrice').value,'');assert.equal(node('orderCostPrice').dataset.autofillCost,undefined);
});
test('quote rows debounce independently',async()=>{
    const {c,rows}=setup();const a=rows(),b=rows();a.input.value='A';b.input.value='B';
    c.window.onItemModelInput(a.input);c.window.onItemModelInput(b.input);
    await new Promise(resolve=>setTimeout(resolve,220));
    assert.equal(a.row.querySelector('.item-product-id').value,'a');assert.equal(b.row.querySelector('.item-product-id').value,'b');
});
test('quote lookup failure displays retry instruction instead of a false not-found result',async()=>{
    const {c,rows}=setup();const {row,input}=rows();c.findProductsByCode=async()=>{throw Error('offline');};
    input.value='A';await c.window.onItemModelChange(input);
    assert.equal(input.dataset.autofillStatus,'error');assert.match(row.querySelector('.quote-warehouse-stock-hint').textContent,/重新輸入/);
    assert.equal(input.missing,undefined);
});
