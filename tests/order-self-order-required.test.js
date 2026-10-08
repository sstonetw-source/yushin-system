const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const api = require('../modules/order-self-order-required.js');

test('self-order requires supplier and nonnegative numeric cost, but accepts explicit zero', () => {
    for (const supplier of ['', '   ', null]) {
        assert.equal(api.validate(true,supplier,'5').field,'orderSelfSupplier');
    }
    for (const cost of ['',null,'-1','not a number','Infinity']) {
        assert.equal(api.validate(true,'Vendor',cost).field,'orderCostPrice');
    }
    for (const cost of ['0',0,'15.25']) {
        assert.equal(api.validate(true,'Vendor',cost).valid,true);
    }
    assert.equal(api.validate(false,'','').valid,true);
});

test('the order form gates adding a self-order item and saving an incomplete one', () => {
    const elements={};
    for (const name of ['orderProcurementType','orderSelfSupplier','orderCostPrice',
       'orderSelfSupplierRequired','orderCostPriceRequired','orderSelfCostHint',
       'orderItemCode','orderItemName','orderItemNameEn','orderModalOverlay']) {
        elements[name]={value:'',hidden:false,style:{},dataset:{},
          listeners:{},addEventListener(type,handler){this.listeners[type]=handler;},
          setCustomValidity(message){this.validationMessage=message;},
          focus(){this.focused=true;},reportValidity(){return !this.validationMessage;}};
    }
    elements.orderProcurementType.value='SALES_SELF_ORDER';
    elements.orderItemCode.value='123';
    elements.orderModalOverlay.contains=()=>true;
    const calls=[];
    const sandbox={document:{getElementById:name=>elements[name]||null},
        onOrderProcurementTypeChange(){calls.push('switch');}};
    sandbox.globalThis=sandbox;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../modules/order-self-order-required.js'),'utf8'),sandbox);
    const invoke=(action)=>{
        const button={getAttribute:()=>action};
        let stopped=false;
        elements.orderModalOverlay.listeners.click({
           target:{closest:()=>button},preventDefault(){stopped=true;},
           stopImmediatePropagation(){stopped=true;}
        });
        return stopped;
    };
    assert.equal(elements.orderSelfSupplier.required,true);
    assert.equal(elements.orderCostPrice.required,true);
    assert.equal(invoke('addCurrentOrderItemToDraft()'),true);
    elements.orderSelfSupplier.value='Vendor';
    assert.equal(invoke('addCurrentOrderItemToDraft()'),true);
    elements.orderCostPrice.value='0';
    assert.equal(invoke('addCurrentOrderItemToDraft()'),false);
    elements.orderCostPrice.value='';
    assert.equal(invoke('saveNewOrder()'),true);
    elements.orderProcurementType.value='PURCHASING_PO';
    sandbox.onOrderProcurementTypeChange();
    assert.equal(elements.orderSelfSupplier.required,false);
    assert.equal(elements.orderCostPrice.required,false);
    assert.equal(invoke('addCurrentOrderItemToDraft()'),false);
});
