const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('app.js','utf8');
const logistics=require('../modules/warehouse-logistics');
function functions(from,to){return app.slice(app.indexOf('function '+from+'('),app.indexOf('function '+to+'('));}

test('order cancellation is authoritative in either field, independent of active or completed status',()=>{
  const c=vm.createContext({BUSINESS_STATUS:{CANCELLED:'cancelled',VOIDED:'voided'}});
  vm.runInContext(functions('normalizedOrderStatus','orderLifecycleInfo'),c);
  for(const status of ['active','completed','normal','cancelled','voided',undefined]){
    for(const orderStatus of ['normal','cancelled','voided',undefined]){
      const cancelled=[status,orderStatus].some(value=>['cancelled','voided'].includes(value));
      assert.equal(c.normalizedOrderStatus({status,orderStatus}),cancelled?'cancelled':'normal');
    }
  }
});

test('billing date and completion derive from billing and fulfillment, not invoice or payment dates',()=>{
  const c=vm.createContext({dateOnlyFromTimestamp:value=>String(value||'').slice(0,10),
    deliveryProgressInfo:()=>({state:'complete'}),savedDeliveryRecords:order=>order.deliveryRecords||[],
    savedReturnRecords:order=>order.returnRecords||[]});
  vm.runInContext(functions('orderBillingDate','orderPeriodRange'),c);
  const order={isBilled:true,billingDate:'2026-10-20',invoiceDate:'2026-10-01',paymentDate:'2026-11-01',
    deliveryRecords:[{date:'2026-10-22'}],returnRecords:[]};
  assert.equal(c.orderBillingDate(order),'2026-10-20');
  assert.equal(c.orderCompletionDate(order),'2026-10-22');
  assert.equal(c.orderCompletionDate({...order,isBilled:false}),'');
});

test('customer shipment labels use actual shipment evidence and do not treat custody as customer delivery',()=>{
  const item={itemId:'I1',qty:5,warehouseId:'W1'};
  const order={deliveryRecords:[{itemId:'I1',sourceType:'INVENTORY_SHIPMENT',qty:5}]};
  assert.equal(logistics.shippingStatus(order,item,{delivered:5}),'已送貨（已寄客戶）');
  assert.equal(logistics.shippingStatus(order,item,{delivered:2}),'部分已寄客戶 2／5');
  assert.equal(logistics.shippingStatus(order,{...item,itemId:'other'},{delivered:5}),'已送貨');
  assert.equal(logistics.shippingStatus({}, {...item,warehouseId:'custody-OWNER',deliveryPlan:{mode:'SALES_SHIP'}},
    {delivered:0}),'已寄負責人・待送客戶');
});
