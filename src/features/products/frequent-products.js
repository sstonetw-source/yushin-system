/* Company favourites use product master IDs and sale prices, never transaction history or costs. */
const PRODUCT_FREQUENT_PAGE_SIZE = 20;
const productFrequentCache = new Map();
const productFrequentWrites = new Set();
let productFrequentActive = null;

function isVisibleFrequentProduct(product, brand) {
    return product.isFrequentlySold===true&&product.active!==false&&product.status!=='INACTIVE'
        && normalizeBrandLookupKey(resolveBrandName(product.brandName||product.brand||''))===normalizeBrandLookupKey(resolveBrandName(brand||''));
}

function invalidateProductFrequentCache() {
    productFrequentCache.clear();
    if(productManagementSourceMode==='frequent'){
        productManagementSearchGeneration++;
        productManagementSearchInProgress=false;
    }
}

window.loadFrequentProducts = async function(brand, loadMore = false) {
    if (!canAccessPage('products') || !brand || productManagementSearchInProgress) return;
    const uid=currentUser?.uid, role=currentUserRole;
    if (!uid) return;
    const generation=++productManagementSearchGeneration;
    const current=()=>generation===productManagementSearchGeneration&&uid===currentUser?.uid&&role===currentUserRole;
    const names=dedupeBrandsCaseInsensitive([brand,...(brandMasterEntryForName(brand)?.aliases||[])]).slice(0,10);
    const key=JSON.stringify([uid,role,names]);
    let state=productFrequentCache.get(key);
    if (!state || Date.now()-state.at>300000) state={rows:new Map(),cursor:null,hasMore:false,loaded:false,at:Date.now()};
    productFrequentActive={brand,state,key};
    productManagementSearchInProgress=true;
    productManagementSourceMode='frequent';
    productManagementActiveSearch=null;
    if (!loadMore) productManagementResults=[];
    const input=document.getElementById('productManagementSearch');if(input)input.value='';
    const status=document.getElementById('productManagementSearchStatus');
    if(status)status.textContent=`正在讀取 ${brand} 常賣品項…`;
    renderProductManagementResults();
    updateProductSearchControls();
    try {
        if (!state.loaded || (loadMore&&state.hasMore)) {
            let query=db.collection('products').where('isFrequentlySold','==',true)
                .where('brandName',names.length>1?'in':'==',names.length>1?names:brand)
                .orderBy(firebase.firestore.FieldPath.documentId()).limit(PRODUCT_FREQUENT_PAGE_SIZE);
            if(state.cursor)query=query.startAfter(state.cursor);
            const page=await firestoreReadWithTimeout(query.get(),`${brand} 常賣品項`);
            if(!current())return;
            page.docs.forEach(doc=>state.rows.set(doc.id,{...doc.data(),id:doc.id}));
            state.cursor=page.docs.at(-1)||state.cursor;
            state.hasMore=page.size===PRODUCT_FREQUENT_PAGE_SIZE;
            state.loaded=true;
            productFrequentCache.set(key,state);
            if(productFrequentCache.size>20)productFrequentCache.delete(productFrequentCache.keys().next().value);
        }
        if(!current())return;
        productManagementResults=[...state.rows.values()].filter(row=>row.isFrequentlySold===true&&row.active!==false&&row.status!=='INACTIVE');
        productManagementVisibleLimit=Math.max(PRODUCT_MANAGEMENT_RENDER_STEP,productManagementResults.length);
        renderProductManagementResults();
        if(status)status.textContent=productManagementResults.length
            ? `${brand}：常賣品項 ${productManagementResults.length} 筆${state.hasMore?'，可載入更多':''}。`
            : state.hasMore?'此批常賣品項已停用，可載入更多。':`${brand} 尚未設定啟用的常賣品項，可輸入完整貨號搜尋。`;
    } catch(err) {
        if(!current())return;
        if(status)status.textContent=productOperationErrorMessage(`${brand} 常賣品項讀取`,err)+'可重新點選廠牌重試。';
    } finally {
        if(current()){
            productManagementSearchInProgress=false;
            updateProductSearchControls();updateProductManagementMoreButton();
        }
    }
};

window.setProductFrequentlySold = async function(productId, enabled, button) {
    if(!canAccessPage('products')||!canManagePendingProductMaster()||productFrequentWrites.has(productId))return;
    const product=productManagementResults.find(row=>(row.productId||row.id)===productId);
    if(!product)return;
    if(enabled&&(product.active===false||product.status==='INACTIVE')){alert('停用產品不能加入常賣品項，請先啟用。');return;}
    const uid=currentUser?.uid,role=currentUserRole;
    const state=beginActionButton(button,'儲存中…');if(button&&!state)return;
    productFrequentWrites.add(productId);
    try {
        await db.collection('products').doc(productId).update({isFrequentlySold:enabled===true,updatedAt:new Date().toISOString(),updatedBy:uid});
        invalidateProductFrequentCache();productManagementSearchCache.clear();
        if(uid!==currentUser?.uid||role!==currentUserRole)return;
        const next={...product,isFrequentlySold:enabled===true};
        if(productManagementSourceMode==='frequent'&&productFrequentActive){
            const active=productFrequentActive;
            if(enabled)active.state.rows.set(productId,next);else active.state.rows.delete(productId);
            productFrequentCache.set(active.key,active.state);
        }
        productManagementResults=productManagementResults.map(row=>(row.productId||row.id)===productId?next:row);
        if(productManagementSourceMode==='frequent'&&!enabled)productManagementResults=productManagementResults.filter(row=>(row.productId||row.id)!==productId);
        if(productManagementSelection.has(productId))productManagementSelection.set(productId,next);
        renderProductManagementResults();
        updateProductSearchControls();
        showActionFeedback(enabled?'已加入公司常賣品項。':'已移出公司常賣品項。');
    } catch(err) {
        alert(productOperationErrorMessage(`${product.manufacturerPartNo||productId} 常賣設定`,err));
    } finally { productFrequentWrites.delete(productId);endActionButton(button,state); }
};

function productInformationText(product) {
    const brand=resolveBrandName(product.brandName||product.brand||'');
    const price=isBrandPriceListActive(brand)?Number(product.listPrice??product.price??0):0;
    return [`廠牌：${brand}`,`貨號：${product.manufacturerPartNo||product.sku||''}`,
        `品名：${product.productName||product.nameCn||product.nameEn||''}`,
        `建議售價：${price?price.toLocaleString():'未提供'}`].join('\n');
}

window.copyProductInformation = async function(productId, button) {
    if(!canAccessPage('products'))return;
    const product=productManagementResults.find(row=>(row.productId||row.id)===productId);
    if(!product){alert('找不到這筆產品，請重新搜尋後再複製。');return;}
    const state=beginActionButton(button,'複製中…');if(button&&!state)return;
    try {
        await navigator.clipboard.writeText(productInformationText(product));
        showActionFeedback('已複製廠牌、貨號、品名與建議售價。');
    } catch(err) { alert('無法複製產品資訊，請允許瀏覽器使用剪貼簿後再試。'); }
    finally { endActionButton(button,state); }
};
