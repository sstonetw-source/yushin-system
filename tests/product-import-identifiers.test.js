const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const code=source.slice(source.indexOf('function productImportSheetRows('),source.indexOf('window.downloadProductMasterTemplate ='));
test('formatted and text codes retain zero while amounts remain raw numbers',()=>{
 const raw=[{貨號:6612601001,價格:1234.5},{貨號:'05264839001',價格:0},{'Cat No.':123456789012,成本:300}];
 const display=[{貨號:'06612601001',價格:'1,234.50'},{貨號:'05264839001',價格:'0'},{'Cat No.':'1.23E+11',成本:'300'}];
 const c=vm.createContext({XLSX:{utils:{sheet_to_json:(_,opts)=>opts.raw?raw:display}}});vm.runInContext(code,c);
 const rows=c.productImportSheetRows({});assert.equal(rows[0].貨號,'06612601001');assert.equal(rows[0].價格,1234.5);assert.equal(rows[1].貨號,'05264839001');assert.equal(rows[2]['Cat No.'],'123456789012');assert.equal(raw[0].貨號,6612601001);
});
