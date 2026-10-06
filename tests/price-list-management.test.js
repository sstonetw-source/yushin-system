const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');

function sliceBetween(source,start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a);
  assert.ok(a>=0 && b>a,`missing range: ${start}`);
  return source.slice(a,b);
}

test('admin backend separates price-list management from Product Master editing',()=>{
  assert.match(html,/admin-sub-products[^>]*>📑 價目表管理</);
  const panel=sliceBetween(html,'<div id="admin-products"','<div id="admin-agencies"');
  assert.match(panel,/價目表管理/);
  assert.match(panel,/deleteEntirePriceList/);
  assert.match(panel,/productImportExcelInput/);
  assert.doesNotMatch(panel,/openNewProductMasterEditor/);
  assert.doesNotMatch(panel,/編輯主檔/);
});

test('whole price-list deletion preserves Product Master documents',()=>{
  const fn=sliceBetween(app,'window.deleteEntirePriceList = async function','// 舊的「移除整個廠牌產品」');
  assert.match(fn,/listPrice:firebase\.firestore\.FieldValue\.delete\(\)/);
  assert.match(fn,/batch\.delete\(db\.collection\('productCosts'\)/);
  assert.match(fn,/batch\.set\(db\.collection\('products'\)/);
  assert.doesNotMatch(fn,/batch\.delete\(db\.collection\('products'\)/);
});

test('price-list lifecycle is versioned and can be disabled without disabling products',()=>{
  assert.match(app,/recordType:'PRICE_LIST'/);
  assert.match(app,/markPriceListImportComplete/);
  assert.match(app,/function isBrandPriceListActive/);
  assert.match(app,/price: priceListActive \?/);
  const toggle=sliceBetween(app,'window.togglePriceListActive = async function','async function readProductsForPriceListBrand');
  assert.doesNotMatch(toggle,/status:'INACTIVE'/);
  assert.doesNotMatch(toggle,/active:false/);
});
