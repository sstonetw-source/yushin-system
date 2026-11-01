const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the shipped generator with either a bounded fake or the real Rules SDK.
exports.quoteNumberGenerator = function(database, {role='sales', uid='sales1', code='S01', selectedCode=code}={}) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/features/quotations/quotation-workspace.js'), 'utf8');
    const start = source.indexOf('window.generateQuoteNo = async function()');
    const end = source.indexOf('\nwindow.onSalesChange', start);
    const input = {value:''}, errors = [];
    const owner = {ownerUid:uid,salesCode:code,salesName:'Owner'};
    const context = {
        window:{}, quoteNoGeneration:0, sessionDataGeneration:0, db:database, editingQuoteNo:'', restoringQuoteDraft:false,
        companyData:{YS:{prefix:'YS'}}, currentCompany:'YS',
        currentUser:uid ? {uid} : null, currentUserRole:role, currentUserCode:code,
        currentUserName:'Owner', salesList:[{uid,name:'Owner',code,role}],
        quoteOwnerFromSelection:()=>owner,
        document:{getElementById:id => id==='quoteNo' ? input : id==='salesName' ? {value:'Selected'} : null},
        getFormattedDateCode:()=>'20261031', canViewAllData:()=>['admin','purchaser'].includes(role),
        firestoreReadWithTimeout:promise=>promise, saveQuoteDraft:()=>{},
        setQuoteOutputStatus:message=>errors.push(message), console:{error:()=>{}}
    };
    vm.createContext(context);
    vm.runInContext(source.slice(start,end), context);
    return {context, input, errors, generate:()=>context.window.generateQuoteNo()};
};
