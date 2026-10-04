(function(root,factory){
    const api=factory();
    if(typeof module==='object'&&module.exports)module.exports=api;
    if(root)root.YushinTradeAnalysis=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
    const kinds=['incoming','purchases','pending','sales','stock'];
    function summarize(rows=[],filters={}){
        const details=Object.fromEntries(kinds.map(kind=>[kind,[]]));
        const totals=Object.fromEntries(kinds.map(kind=>[kind,0]));
        const missing=Object.fromEntries(kinds.map(kind=>[kind,0]));
        const brands=new Map();
        rows.forEach(row=>{
            if(!kinds.includes(row.kind))return;
            if(filters.brand&&row.brand!==filters.brand)return;
            if(filters.line&&row.line!==filters.line)return;
            if(filters.type&&row.type!==filters.type)return;
            // Shared company purchasing / inventory have no salesperson allocation.
            if(['sales','pending'].includes(row.kind)&&filters.sales&&row.sales!==filters.sales)return;
            if(['sales','purchases'].includes(row.kind)
                &&(!row.date||(filters.start&&row.date<filters.start)||(filters.end&&row.date>filters.end)))return;
            details[row.kind].push(row);
            if(!brands.has(row.brand))brands.set(row.brand,{brand:row.brand,...Object.fromEntries(kinds.map(kind=>[kind,0]))});
            const group=brands.get(row.brand);
            if(row.amount===null||!Number.isFinite(row.amount))missing[row.kind]++;
            else{totals[row.kind]+=row.amount;group[row.kind]+=row.amount;}
        });
        return {details,totals,missing,brands:[...brands.values()]};
    }
    return {kinds,summarize};
});
