const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const app=fs.readFileSync('app.js','utf8'),html=fs.readFileSync('index.html','utf8');
test('removed external notice and supplier email have no UI or loaded runtime, warehouses retain normal dispatch',()=>{
 assert.doesNotMatch(html,/external-warehouse-dispatch.js|externalWarehousePanel|emailPurchaseOrderBtn|supplierSettingEmail/);
 assert.doesNotMatch(app,/window.emailPurchaseOrder|viewExternalWarehouseStatus\(|loadRecentExternalWarehouseNotices/);
 assert.doesNotMatch(app,/if \(isExternalWarehouseId\(warehouseId\)\) return/);
 assert.match(html,/autoFillPoExpectedDate\(\); renderPoItemsTable\(\)/);
 assert.match(fs.readFileSync('functions/index.js','utf8'),/throw new HttpsError/);
 assert.doesNotMatch(fs.readFileSync('functions/index.js','utf8'),/nodemailer|smtpConfig/);
});
