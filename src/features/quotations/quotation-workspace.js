/* =========================================================
   估價單系統
   ========================================================= */
// 業務名單來源改為 users 集合（與登入帳號綁定，name/code/phone/role 皆存在同一份文件）
function applySalesRows(rows) {
    const list = (rows || [])
        .filter(d => d.name && (d.salesCode || d.code) && d.active !== false && d.disabled !== true)
        .map(d => ({ uid:d.id || d.uid || '', code:d.salesCode || d.code, name:d.name, phone:d.phone || '', role:d.role || 'sales', deliveryDefaults:d.deliveryDefaults||{}, active:true }));
    list.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
    salesList = list;
    populateSalesDropdown();
    populateEquipmentSalesDropdown();
    return salesList;
}

function initSalesList() {
    const generation=sessionDataGeneration;
    // Admin 已讀過 users 時直接共用同一份記憶體資料，避免再次掃描 users collection。
    if (allUsersCache.length) {
        applySalesRows(allUsersCache.map(u => ({ id:u.uid, ...u })));
        return Promise.resolve(salesList);
    }
    return readCollectionInBatches('users').then(rows => generation===sessionDataGeneration ? applySalesRows(rows) : []).catch(err => {
        if (generation!==sessionDataGeneration) return [];
        console.error('讀取 users 人員名單失敗：', err);
        // 短暫斷線時保留既有名單；不要把畫面上的業務選項清空。
        populateSalesDropdown();
        populateEquipmentSalesDropdown();
        throw err;
    });
}

function applyCompanyTheme(compKey, el) {
    currentCompany = compKey;
    document.querySelectorAll('.company-sub-nav .sub-tab').forEach(t => t.classList.remove('active'));

    const targetTab = document.getElementById(`sub-${compKey}`);
    if (targetTab) {
        targetTab.classList.add('active');
    } else if (el) {
        el.classList.add('active');
    }

    const info = companyData[compKey];
    if (info) {
        document.getElementById('compTitle').innerText = info.title;
        document.getElementById('compSub').innerText = info.sub;
        document.getElementById('compAddr').innerText = info.addr;
        document.getElementById('compContact').innerHTML = info.contact;
        document.getElementById('companyStamp').src = info.stamp;
    }

    const printableEl = document.getElementById('printableQuote');
    printableEl.classList.remove('theme-yushin', 'theme-morningstar', 'theme-MULTI-LIFE');
    printableEl.classList.add(`theme-${compKey}`);

    populateQuoteBrandDropdowns();
}

// 手動切換公司分頁時，套用主題之外還要重新產生一個新單號（原本的行為）
window.switchCompany = function(compKey, el) {
    setQuoteEditingContext('');
    setQuoteOutputStatus('');
    applyCompanyTheme(compKey, el);
    generateQuoteNo();
};

function initDate() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    document.getElementById('quoteDate').value = `${yyyy}/${mm}/${dd}`;
}

function getFormattedDateCode() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
}

window.generateQuoteNo = async function() {
    const quoteNoInput = document.getElementById('quoteNo');
    if (editingQuoteNo && !restoringQuoteDraft) {
        if (quoteNoInput) quoteNoInput.value = editingQuoteNo;
        return editingQuoteNo;
    }

    const info = companyData[currentCompany];
    const dateStr = getFormattedDateCode();

    const salesInput = document.getElementById('salesName');
    let salesCode = "01";

    if (salesInput && salesInput.value) {
        const typedName = salesInput.value.trim();
        const selectedUid = salesInput.selectedOptions?.[0]?.dataset.ownerUid || '';
        const selectedOwner = salesList.find(s => s.uid === selectedUid && isSelectableCommercialOwner(s));
        if (selectedOwner) salesCode = selectedOwner.code;
        else if (typedName === currentUserName && currentUserCode && currentUserRole !== 'purchaser') salesCode = currentUserCode;
    }

    const prefix = `${info.prefix}-${dateStr}-${salesCode}-`;

    try {
        const newestInPrefix = () => db.collection('quotes')
            .where('quoteNo', '>=', prefix)
            .where('quoteNo', '<=', prefix + '\uf8ff')
            .orderBy('quoteNo', 'desc')
            .limit(1);
        const queries = [];
        if (canViewAllData('quotes')) {
            queries.push(newestInPrefix());
        } else {
            // Match the same ownership paths as the quote list and Rules.
            // Each path reads at most one record, including legacy code ownership
            // Never issue an unscoped read for an engineer-created document owned by another person.
            if (currentUserCode) queries.push(newestInPrefix().where('salesCode', '==', currentUserCode));
            if (currentUser?.uid) queries.push(newestInPrefix().where('ownerUid', '==', currentUser.uid));
            if (!queries.length) throw new Error('目前帳號缺少可用的資料歸屬資訊');
        }
        const snapshots = await Promise.all(queries.map(query => firestoreReadWithTimeout(query.get(), '估價單號')));

        // 用「目前已存在的最大流水號 + 1」而非「筆數 + 1」：
        // 因為 Firestore 是拿 quoteNo 當文件 ID，如果中間有一張估價單被刪除，
        // 用筆數計算會讓新單號跟既有的某張估價單撞號，寫入時直接覆蓋掉那張舊資料
        let maxSeq = 0;
        snapshots.forEach(snapshot => snapshot.forEach(doc => {
            const seqStr = (doc.data().quoteNo || '').split('-').pop();
            const seq = parseInt(seqStr, 10);
            if (!isNaN(seq) && seq > maxSeq) {
                maxSeq = seq;
            }
        }));
        const count = maxSeq + 1;
        if (quoteNoInput) quoteNoInput.value = `${prefix}${String(count).padStart(2, '0')}`;
        const outputStatus = document.getElementById('quoteOutputStatus');
        if (outputStatus?.classList.contains('is-error') && outputStatus.innerText.includes('無法取得安全的估價單號')) {
            setQuoteOutputStatus('');
        }
    } catch (e) {
        console.error('取得估價單號失敗：', e);
        if (quoteNoInput) quoteNoInput.value = '';
        setQuoteOutputStatus('無法取得安全的估價單號，請確認網路後再試一次。', true);
    }
    if (!restoringQuoteDraft) saveQuoteDraft();
    return quoteNoInput?.value || '';
};

window.onSalesChange = function() {
    if (!editingQuoteNo) generateQuoteNo();
    updateSalesPhoneDisplay();
};

// 業務／工程師僅能建立本人名下的估價單；採購／管理員可代有效商務負責人建立。
function populateSalesDropdown() {
    const select = document.getElementById('salesName');
    if (!select) return;

    const visibleList = salesList.filter(s => isSelectableCommercialOwner(s)
        && (!['sales','engineer'].includes(currentUserRole) || s.uid === currentUser?.uid));

    if ((currentUserRole === 'sales' || currentUserRole === 'engineer') && currentUser?.uid && currentUserName
        && !visibleList.some(s => s.uid === currentUser.uid)) {
        if (currentUserCode) visibleList.push({ uid: currentUser.uid, name: currentUserName, code: currentUserCode, role: currentUserRole });
    }

    const currentValue = select.value;
    const currentOwnerUid = select.selectedOptions?.[0]?.dataset.ownerUid || '';
    select.innerHTML = '<option value="">請選擇負責業務</option>';
    visibleList.forEach(s => {
        if (s.name) {
            const option = document.createElement('option');
            option.value = s.name;
            option.text = s.name;
            option.dataset.ownerUid = s.uid;
            option.dataset.salesCode = s.code;
            select.appendChild(option);
        }
    });

    // 如果有等待中的草稿業務姓名（頁面載入時從本機草稿還原的），優先套用這個，只套用一次
    let valueToApply = currentValue;
    if (window._pendingDraftSalesName !== undefined) {
        valueToApply = window._pendingDraftSalesName;
        delete window._pendingDraftSalesName;
    }
    const preferredUid = window._pendingDraftSalesUid || currentOwnerUid;
    delete window._pendingDraftSalesUid;
    // 保留有效的草稿選擇；本人登入時預設帶入自己，採購／管理員保持未選擇。
    select.value = visibleList.some(s => s.name === valueToApply) ? valueToApply
        : ((currentUserRole === 'sales' || currentUserRole === 'engineer') ? currentUserName : '');
    if (preferredUid) {
        const index = [...select.options].findIndex(option => option.dataset.ownerUid === preferredUid);
        if (index >= 0) select.selectedIndex = index;
    }

    // 還原草稿與編輯既有估價單時都沿用原單號；只有真正的新單才重新取號。
    if (!restoringQuoteDraft && !editingQuoteNo) generateQuoteNo();
    updateSalesPhoneDisplay();
}

// 依目前輸入的業務姓名，更新旁邊顯示的電話號碼
function updateSalesPhoneDisplay() {
    const input = document.getElementById('salesName');
    const phoneSpan = document.getElementById('salesPhone');
    if (!input || !phoneSpan) return;

    const selectedName = input.value.trim();
    const match = salesList.find(s => s.uid === input.selectedOptions?.[0]?.dataset.ownerUid && s.name === selectedName);
    phoneSpan.innerText = match ? (match.phone || '')
        : (selectedName === currentUserName ? (currentUserPhone || '') : '');
}

function populateEquipmentSalesDropdown() {
    const select = document.getElementById('eqSales');
    if (!select) return;
    select.innerHTML = '<option value="">未指定負責業務</option>';
    const visibleList = canViewAllEquipment()
        ? salesList.filter(isSelectableCommercialOwner)
        : (currentUserName && currentUserCode ? [{ uid:currentUser?.uid, name:currentUserName, code:currentUserCode, phone:currentUserPhone }] : []);
    visibleList.forEach(s => {
        if (s.name) {
            const option = document.createElement('option');
            option.value = s.name;
            option.text = s.name;
            option.dataset.ownerUid = s.uid;
            option.dataset.salesCode = s.code;
            select.appendChild(option);
        }
    });
}

function loadCompanyAgencyBrandSettings() {
    return firestoreReadWithTimeout(
        db.collection('settings').doc('companyAgencyBrands').get(),
        '公司代理廠牌設定'
    ).then(doc => {
        companyAgencyBrandsConfigured = doc.exists;
        const data = doc.exists ? doc.data() : {};
        const saved = data.companies || {};
        companyAgencyBrands = {
            yushin: normalizeThermoBrandList(saved.yushin || []),
            morningstar: normalizeThermoBrandList(saved.morningstar || []),
            'MULTI-LIFE': normalizeThermoBrandList(saved['MULTI-LIFE'] || [])
        };
        // 舊設定曾將 thermo 以小寫存進雲端；載入時統一分公司代理設定的名稱。
        const rawCompanies = {
            yushin: saved.yushin || [],
            morningstar: saved.morningstar || [],
            'MULTI-LIFE': saved['MULTI-LIFE'] || []
        };
        const needsThermoCleanup = JSON.stringify(companyAgencyBrands) !== JSON.stringify(rawCompanies);
        if (needsThermoCleanup && currentUserRole === 'admin') {
            db.collection('settings').doc('companyAgencyBrands').set({
                companies: companyAgencyBrands
            }, { merge: true }).catch(err => console.error('清理小寫 thermo 設定失敗：', err));
        }
        renderCompanyAgencyBrandSettings();
        // 代理廠牌設定只影響可選廠牌；不重建整份產品 datalist。
        // Product Master 真正新增／匯入時才呼叫 refreshPriceDatalists()。
    }).catch(() => {
        companyAgencyBrandsConfigured = false;
    });
}

function loadSalesStatisticsSettings() {
    return firestoreReadWithTimeout(
        db.collection('settings').doc('salesStatistics').get(),
        '重點廠牌設定'
    ).then(doc => {
        const saved = doc.exists ? doc.data() : {};
        const savedBrands = doc.exists ? (saved.keyBrands || []) : DEFAULT_KEY_STATISTIC_BRANDS;
        keyStatisticBrands = normalizeThermoBrandList(savedBrands);
        maintenanceBrandMigrationPending = saved.maintenanceBrandManaged !== true;
        if (maintenanceBrandMigrationPending && !includesBrandCaseInsensitive(keyStatisticBrands, '維修')) {
            keyStatisticBrands.push('維修');
        }
        const savedAliases = saved.brandAliases || {};
        const aliasBrands = new Set([...Object.keys(DEFAULT_STATISTIC_BRAND_ALIASES), ...Object.keys(savedAliases)]);
        keyStatisticBrandAliases = {};
        aliasBrands.forEach(brand => {
            keyStatisticBrandAliases[brand] = dedupeBrandsCaseInsensitive([
                ...(DEFAULT_STATISTIC_BRAND_ALIASES[brand] || []),
                ...(savedAliases[brand] || [])
            ]);
        });
        if (doc.exists && JSON.stringify(keyStatisticBrands) !== JSON.stringify(savedBrands) && currentUserRole === 'admin') {
            db.collection('settings').doc('salesStatistics').set({ keyBrands: keyStatisticBrands }, { merge: true })
                .catch(err => console.error('清理重點代理廠牌的小寫 thermo 失敗：', err));
        }
        renderKeyStatisticBrands();
        if (salesStatisticsOrders.length) renderSalesStatistics();
    }).catch(() => {
        keyStatisticBrands = DEFAULT_KEY_STATISTIC_BRANDS.slice();
        keyStatisticBrandAliases = JSON.parse(JSON.stringify(DEFAULT_STATISTIC_BRAND_ALIASES));
        maintenanceBrandMigrationPending = true;
        renderKeyStatisticBrands();
    });
}

let brandSettingsLoadPromise = null;
function ensureBrandSettingsLoaded() {
    if (!brandSettingsLoadPromise) {
        brandSettingsLoadPromise = Promise.all([
            loadSalesStatisticsSettings(), loadCompanyAgencyBrandSettings(), loadBrandMaster()
        ]).then(async () => {
            if (maintenanceBrandMigrationPending && trueUserRole === 'admin') {
                await upsertBrandMaster('維修', { isKeyBrand:true, active:true });
                await db.collection('settings').doc('salesStatistics').set({
                    keyBrands: normalizeThermoBrandList(keyStatisticBrands),
                    maintenanceBrandManaged: true
                }, { merge:true });
                maintenanceBrandMigrationPending = false;
            }
            refreshBusinessBrandControls();
            renderBrandAliasManager();
            renderCompanyAgencyBrandSettings();
        }).catch(err => {
            brandSettingsLoadPromise = null;
            throw err;
        });
    }
    return brandSettingsLoadPromise;
}

const PRODUCT_DATALIST_RECENT_LIMIT = 50;
const PRODUCT_CODE_SUGGESTION_LIMIT = 20;
let productCodeSuggestionTimer = null;
let productCodeSuggestionGeneration = 0;
const productCodeMatchCache = new Map();

function recentProductSuggestions(limit = PRODUCT_DATALIST_RECENT_LIMIT) {
    return [...priceList]
        .filter(item => item.status !== 'INACTIVE' && item.active !== false)
        .slice(-limit)
        .reverse();
}

function renderProductCodeSuggestions(items = recentProductSuggestions()) {
    const modelList = document.getElementById('priceModelList');
    if (!modelList) return;
    modelList.innerHTML = (items || []).slice(0, PRODUCT_DATALIST_RECENT_LIMIT).map(item => {
        const label = [resolveBrandName(item.brand || ''), item.nameCn || item.nameEn || ''].filter(Boolean).join('｜');
        return `<option value="${escapeAttr(item.model || '')}" label="${escapeAttr(label)}"></option>`;
    }).join('');
}

window.queueProductCodeSuggestions = function(value) {
    clearTimeout(productCodeSuggestionTimer);
    const normalized = normalizeItemCodeLoose(value);
    const generation = ++productCodeSuggestionGeneration;
    if (normalized.length < 2) {
        renderProductCodeSuggestions();
        return;
    }
    productCodeSuggestionTimer = setTimeout(async () => {
        try {
            const snapshot = await firestoreReadWithTimeout(
                db.collection('products')
                    .orderBy('normalizedPartNo')
                    .startAt(normalized)
                    .endAt(normalized + '\uf8ff')
                    .limit(PRODUCT_CODE_SUGGESTION_LIMIT)
                    .get(),
                '產品主檔貨號建議'
            );
            if (generation !== productCodeSuggestionGeneration) return;
            const matches = snapshot.docs
                .map(productMasterDocToPriceItem)
                .filter(item => item.status !== 'INACTIVE' && item.active !== false);
            const merged = new Map(priceList.map(item => [item.productId || stableProductId(item), item]));
            matches.forEach(item => merged.set(item.productId || stableProductId(item), item));
            priceList = [...merged.values()];
            rebuildPriceItemLookup();
            renderProductCodeSuggestions(matches);
        } catch (err) {
            if (generation === productCodeSuggestionGeneration) {
                console.warn('產品主檔貨號建議讀取失敗：', err);
                renderProductCodeSuggestions();
            }
        }
    }, 180);
};

function refreshPriceDatalists() {
    productCodeMatchCache.clear();
    rebuildPriceItemLookup();
    const cnList = document.getElementById('priceNameCnList');
    const enList = document.getElementById('priceNameEnList');
    if (!cnList || !enList) return;
    const recent = recentProductSuggestions();
    cnList.innerHTML = recent.filter(p => p.nameCn).map(p => `<option value="${escapeAttr(p.nameCn)}"></option>`).join('');
    enList.innerHTML = recent.filter(p => p.nameEn).map(p => `<option value="${escapeAttr(p.nameEn)}"></option>`).join('');
    renderProductCodeSuggestions(recent);
    populateOrderBrandDropdown();
    populateEquipmentBrandDropdown();
    populateQuoteBrandDropdowns();
}

// 舊函式名稱保留供既有模組呼叫；實際候選廠牌已統一由 Brand Master 相容層提供。
function getPriceListBrands(includeMaintenance = false) {
    return getUnifiedBrandNames(includeMaintenance);
}

function dedupeBrandsCaseInsensitive(brands) {
    const unique = new Map();
    (brands || []).forEach(value => {
        const brand = String(value || '').trim();
        const key = brand.toLocaleLowerCase();
        if (brand && !unique.has(key)) unique.set(key, brand);
    });
    return [...unique.values()];
}

function normalizeBrandLookupKey(value) {
    return String(value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s\-_]+/g, '');
}

function defaultCanonicalBrandName(value) {
    const input = String(value || '').normalize('NFKC').trim();
    if (!input) return '';
    const key = normalizeBrandLookupKey(input);
    for (const [canonical, aliases] of Object.entries(DEFAULT_CANONICAL_BRAND_ALIASES)) {
        if (normalizeBrandLookupKey(canonical) === key) return canonical;
        if ((aliases || []).some(alias => normalizeBrandLookupKey(alias) === key)) return canonical;
    }
    return input;
}

function defaultBrandAliasesForCanonical(value) {
    const canonical = defaultCanonicalBrandName(value);
    const key = normalizeBrandLookupKey(canonical);
    for (const [name, aliases] of Object.entries(DEFAULT_CANONICAL_BRAND_ALIASES)) {
        if (normalizeBrandLookupKey(name) === key) return dedupeBrandsCaseInsensitive(aliases || []);
    }
    return [];
}

function normalizeBrandMasterRecord(id, data = {}) {
    const name = String(data.name || data.brand || id || '').trim();
    const priceListProductCount = Number(data.priceListProductCount);
    return {
        id: id || '',
        name,
        aliases: dedupeBrandsCaseInsensitive(data.aliases || []),
        isKeyBrand: data.isKeyBrand === true,
        companies: Array.isArray(data.companies) ? data.companies.filter(Boolean) : [],
        active: data.active !== false,
        priceListManaged: data.priceListManaged === true || !!data.priceListFile || !!data.priceListBatchId || !!data.priceListDeletedAt,
        priceListFile: String(data.priceListFile || ''),
        priceListBatchId: String(data.priceListBatchId || ''),
        priceListUpdatedAt: String(data.priceListUpdatedAt || ''),
        priceListProductCount: Number.isFinite(priceListProductCount) && priceListProductCount >= 0 ? priceListProductCount : 0,
        priceListActive: data.priceListActive !== false,
        priceListDeletedAt: String(data.priceListDeletedAt || ''),
        priceListLastAction: String(data.priceListLastAction || '')
    };
}

function isBrandPriceListActive(brand) {
    const canonical = resolveBrandName(brand || '');
    if (!canonical) return true;
    const entry = brandMasterEntryForName(canonical);
    return entry ? entry.priceListActive !== false : true;
}


let unifiedBrandEntriesCache = null;
let primaryBrandNamesCache = null;

function invalidateBrandDerivedCaches() {
    unifiedBrandEntriesCache = null;
    primaryBrandNamesCache = null;
}

function deferUntilAfterPaint(task, label = '背景初始化') {
    if (typeof task !== 'function') return;
    const run = () => setTimeout(() => {
        Promise.resolve().then(task).catch(err => console.error(label + '失敗：', err));
    }, 0);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
}

function getUnifiedBrandEntries(includeMaintenance = false) {
    if (Array.isArray(unifiedBrandEntriesCache)) return unifiedBrandEntriesCache;
    // Brand Master 的「標準名稱」是全系統唯一廠牌名稱；別名只用來辨識輸入，
    // 不應在 Product Master、估價、訂單或進銷存分析中形成第二個廠牌。
    const entries = new Map();
    const companyKeys = ['yushin', 'morningstar', 'MULTI-LIFE'];
    const masters = brandMasterCache.filter(master => master?.name && master.active !== false);

    const explicitAliasOwners = new Map();
    masters.forEach(master => {
        const ownerName = defaultCanonicalBrandName(master.name);
        (master.aliases || []).forEach(alias => {
            const key = normalizeBrandLookupKey(alias);
            if (key && key !== normalizeBrandLookupKey(ownerName) && !explicitAliasOwners.has(key)) {
                explicitAliasOwners.set(key, ownerName);
            }
        });
    });

    const canonicalForMaster = master => {
        const rawName = String(master?.name || '').trim();
        const aliasOwner = explicitAliasOwners.get(normalizeBrandLookupKey(rawName));
        return defaultCanonicalBrandName(aliasOwner || rawName);
    };

    const statisticConfigForEntry = (master, canonicalName, aliases) => keyStatisticBrands.find(configuredName => {
        const configuredCanonical = defaultCanonicalBrandName(configuredName);
        const configuredKey = normalizeBrandLookupKey(configuredCanonical);
        const configuredAliases = keyStatisticBrandAliases[configuredName]
            || keyStatisticBrandAliases[configuredCanonical]
            || [];
        return configuredKey === normalizeBrandLookupKey(canonicalName)
            || aliases.some(alias => normalizeBrandLookupKey(alias) === configuredKey)
            || configuredAliases.some(alias => normalizeBrandLookupKey(alias) === normalizeBrandLookupKey(canonicalName));
    }) || '';

    masters.forEach(master => {
        const canonicalName = canonicalForMaster(master);
        const key = normalizeBrandLookupKey(canonicalName);
        if (!key) return;

        const baseAliases = dedupeBrandsCaseInsensitive([
            ...(master.aliases || []),
            ...defaultBrandAliasesForCanonical(canonicalName),
            ...(normalizeBrandLookupKey(master.name) !== key ? [master.name] : [])
        ]).filter(alias => String(alias).trim() !== canonicalName);
        const statisticConfig = statisticConfigForEntry(master, canonicalName, baseAliases);
        const aliases = dedupeBrandsCaseInsensitive([
            ...baseAliases,
            ...(statisticConfig ? (keyStatisticBrandAliases[statisticConfig] || []) : [])
        ]).filter(alias => String(alias).trim() !== canonicalName);
        const companies = companyKeys.filter(company =>
            (master.companies || []).includes(company)
            || includesBrandCaseInsensitive(companyAgencyBrands[company] || [], canonicalName)
            || aliases.some(alias => includesBrandCaseInsensitive(companyAgencyBrands[company] || [], alias))
        );

        const existing = entries.get(key);
        if (existing) {
            const masterIsCanonical = normalizeBrandLookupKey(master.name) === key;
            const priceListOwner = master.priceListManaged && (!existing.priceListManaged ||
                String(master.priceListUpdatedAt || master.priceListDeletedAt || '') > String(existing.priceListUpdatedAt || existing.priceListDeletedAt || '')) ? master : existing;
            entries.set(key, {
                ...existing,
                ...Object.fromEntries(Object.entries(priceListOwner).filter(([field]) => field.startsWith('priceList'))),
                id: masterIsCanonical ? master.id : existing.id,
                name: canonicalName,
                aliases: dedupeBrandsCaseInsensitive([...(existing.aliases || []), ...aliases]),
                isKeyBrand: existing.isKeyBrand || master.isKeyBrand === true || !!statisticConfig,
                companies: [...new Set([...(existing.companies || []), ...companies])],
                active: true
            });
        } else {
            entries.set(key, {
                ...master,
                name: canonicalName,
                aliases,
                isKeyBrand: master.isKeyBrand === true || !!statisticConfig,
                companies,
                active: true
            });
        }
    });

    unifiedBrandEntriesCache = [...entries.values()]
        .sort((x, y) => x.name.localeCompare(y.name, 'zh-Hant'));
    return unifiedBrandEntriesCache;
}

function getUnifiedBrandNames(includeMaintenance = false) {
    return getUnifiedBrandEntries(includeMaintenance).map(item => item.name);
}

function stableMasterId(prefix, value) {
    const normalized = String(value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
    return prefix + ':' + (normalized || Date.now().toString(36));
}

function warehouseStockDocId(warehouseId, productKey) {
    return encodeURIComponent(String(warehouseId || '')) + '__' + encodeURIComponent(String(productKey || ''));
}

function warehouseKind(item) {
    // 舊倉庫沒有類型欄位時，延用公司倉庫行為。
    return item?.warehouseType === 'EXTERNAL' ? 'EXTERNAL' : 'INTERNAL';
}

function defaultWarehouse() {
    const internal = warehouseMasterCache.filter(item => item.active !== false && !item.systemCustody && warehouseKind(item) === 'INTERNAL');
    return internal.find(item => item.isDefault) || internal[0] || null;
}

let warehouseMasterLoadPromise = null;

async function loadWarehouseMaster(force = false) {
    if (warehouseMasterLoadPromise && !force) return warehouseMasterLoadPromise;
    warehouseMasterLoadPromise = firestoreReadWithTimeout(
        readCollectionInBatches('warehouses',50),
        '倉庫主檔'
    ).then(rows => {
        warehouseMasterCache = rows
            .filter(item => item.active !== false)
            .sort((a,b)=>Number(b.isDefault)-Number(a.isDefault)||String(a.warehouseName||'').localeCompare(String(b.warehouseName||''),'zh-Hant'));
        renderWarehouseMasterAdmin();
        populateOrderWarehouseOptions();
        window.refreshOrderShippingWarehouses?.();
        return warehouseMasterCache;
    }).catch(err => {
        warehouseMasterLoadPromise = null;
        console.warn('讀取倉庫主檔失敗：', err);
        return warehouseMasterCache;
    });
    return warehouseMasterLoadPromise;
}

async function loadSupplierWarehouseMasters(force = false) {
    if (supplierWarehouseLoadPromise && !force) return supplierWarehouseLoadPromise;
    supplierWarehouseLoadPromise = Promise.all([
        readCollectionInBatches('suppliers'),
        readCollectionInBatches('brandSupplierMappings'),
        loadWarehouseMaster(force)
    ]).then(([suppliers, mappings]) => {
        supplierMasterCache = suppliers.filter(item => item.active !== false);
        supplierMappingCache = mappings.filter(item => item.active !== false);
        supplierMasterCache.sort((a,b)=>String(a.supplierName||'').localeCompare(String(b.supplierName||''),'zh-Hant'));
        renderSupplierMasterAdmin();
        renderSupplierMappingAdmin();
        renderSupplierSettingsAdmin();
        renderWarehouseMasterAdmin();
        populateOrderWarehouseOptions();
        return {
            suppliers:supplierMasterCache,
            mappings:supplierMappingCache,
            warehouses:warehouseMasterCache
        };
    }).catch(err => {
        supplierWarehouseLoadPromise = null;
        console.warn('讀取供應商／倉庫主檔失敗：', err);
        return {
            suppliers:supplierMasterCache,
            mappings:supplierMappingCache,
            warehouses:warehouseMasterCache
        };
    });
    return supplierWarehouseLoadPromise;
}

function supplierForProduct(brand, productLine = '') {
    const brandKey = normalizeBrandLookupKey(resolveBrandName(brand));
    const lineKey = String(productLine || '').normalize('NFKC').trim().toLocaleLowerCase();
    const candidates = supplierMappingCache.filter(item =>
        normalizeBrandLookupKey(item.brandName || item.brand || '') === brandKey
    );
    const lineMatch = candidates.find(item => String(item.productLine || '').normalize('NFKC').trim().toLocaleLowerCase() === lineKey && lineKey);
    const fallback = candidates.find(item => !String(item.productLine || '').trim() && item.isDefault !== false)
        || candidates.find(item => !String(item.productLine || '').trim());
    const mapping = lineMatch || fallback || null;
    if (!mapping) return null;
    const supplier = supplierMasterCache.find(item => item.id === mapping.supplierId || item.supplierId === mapping.supplierId) || null;
    return supplier ? { ...supplier, brandSupplierMapping:mapping } : null;
}

function normalizeSupplierEmail(value='') {
    if (!globalThis.YushinSupplier?.normalizeEmail) {
        throw new Error('Supplier core 未載入，無法處理供應商 Email。');
    }
    return globalThis.YushinSupplier.normalizeEmail(value);
}

function supplierForVendorName(vendorName='') {
    const key=String(vendorName||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase();
    if(!key)return null;
    return supplierMasterCache.find(item=>{
        const supplierName=String(item.supplierName||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase();
        const header=String(item.purchaseHeaderName||item.supplierName||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase();
        return supplierName===key||header===key;
    })||null;
}

function purchaseOrderSupplierContact(po={}) {
    if (!globalThis.YushinSupplier?.purchaseOrderContact) {
        throw new Error('Supplier core 未載入，無法解析採購單供應商。');
    }
    return globalThis.YushinSupplier.purchaseOrderContact(po,supplierMasterCache);
}





function renderSupplierMasterAdmin() {
    const body=document.getElementById('supplierMasterBody');
    const suggestions=document.getElementById('supplierMasterSuggestions');
    if(suggestions){
        suggestions.innerHTML=supplierMasterCache.map(supplier =>
            `<option value="${escapeAttr(supplier.supplierName||'')}">${escapeHtml(supplier.purchaseHeaderName||supplier.supplierName||'')}</option>`
        ).join('');
    }
    if(!body)return;
    body.innerHTML=supplierMasterCache.length?supplierMasterCache.map(supplier=>{
        const supplierId=supplier.id||supplier.supplierId||'';
        const mappingCount=supplierMappingCache.filter(mapping=>mapping.supplierId===supplierId).length;
        const leadTimeDays=Math.max(0,Number(supplier.leadTimeDays||0));
        return `<tr>
            <td>${escapeHtml(supplier.supplierName||'')}</td>
            <td>${escapeHtml(supplier.purchaseHeaderName||supplier.supplierName||'')}</td>
            <td>${escapeHtml(supplier.email||'')}</td>
            <td>${leadTimeDays?leadTimeDays+' 天':'－'}</td>
            <td>${mappingCount}</td>
            <td>
                <button type="button" class="btn-small btn-secondary" onclick="loadSupplierMasterToEditor(${inlineJsValue(supplierId)})">編輯</button>
                <button type="button" class="btn-small btn-danger" onclick="disableSupplierMaster(${inlineJsValue(supplierId)})">停用</button>
            </div></td>
        </tr>`;
    }).join(''):'<tr><td colspan="6" style="color:#888;">尚未建立供應商。</td></tr>';
}

function renderSupplierMappingAdmin() {
    const body = document.getElementById('supplierMappingBody');
    if (!body) return;
    body.innerHTML = supplierMappingCache.length ? supplierMappingCache.map(mapping => {
        const supplier = supplierMasterCache.find(item => item.id === mapping.supplierId || item.supplierId === mapping.supplierId) || {};
        return `<tr>
            <td>${escapeHtml(mapping.brandName || '')}</td>
            <td>${escapeHtml(mapping.productLine || '預設')}</td>
            <td>${escapeHtml(supplier.supplierName || '找不到供應商')}</td>
            <td>${escapeHtml(supplier.purchaseHeaderName || supplier.supplierName || '')}</td>
            <td>${escapeHtml(supplier.email || '')}</td>
            <td><button type="button" class="btn-small btn-danger" onclick="disableSupplierMapping(${inlineJsValue(mapping.id)})">停用</button></td>
        </tr>`;
    }).join('') : '<tr><td colspan="6" style="color:#888;">尚未設定供應商對應。</td></tr>';
}


function renderSupplierSettingsAdmin() {
    const body=document.getElementById('supplierSettingsBody');
    const suggestions=document.getElementById('supplierSettingSuggestions');
    if(suggestions){
        suggestions.innerHTML=supplierMasterCache.map(supplier =>
            `<option value="${escapeAttr(supplier.supplierName||'')}">${escapeHtml(supplier.purchaseHeaderName||supplier.supplierName||'')}</option>`
        ).join('');
    }
    if(!body)return;
    const rows=[...supplierMappingCache].sort((a,b)=>
        String(a.brandName||'').localeCompare(String(b.brandName||''),'zh-Hant')
        || String(a.productLine||'').localeCompare(String(b.productLine||''),'zh-Hant')
    );
    body.innerHTML=rows.length?rows.map(mapping=>{
        const supplier=supplierMasterCache.find(item => item.id===mapping.supplierId || item.supplierId===mapping.supplierId) || {};
        const leadTimeDays=Math.max(0,Number(supplier.leadTimeDays||0));
        return `<tr>
            <td>${escapeHtml(mapping.brandName||'')}</td>
            <td>${escapeHtml(mapping.productLine||'預設')}</td>
            <td>${escapeHtml(supplier.supplierName||'找不到供應商')}</td>
            <td>${escapeHtml(supplier.purchaseHeaderName||supplier.supplierName||'')}</td>
            <td>${leadTimeDays?leadTimeDays+' 天':'－'}</td>
            <td><div class="workflow-inline-actions">
                <button type="button" class="btn-small btn-secondary" onclick="loadSupplierSettingToEditor(${inlineJsValue(mapping.id||mapping.mappingId||'')})">編輯</button>
                <button type="button" class="btn-small btn-danger" onclick="disableSupplierSetting(${inlineJsValue(mapping.id||mapping.mappingId||'')})">停用</button>
            </td>
        </tr>`;
    }).join(''):'<tr><td colspan="6" style="color:#888;">尚未設定供應商。</td></tr>';
}

window.fillSupplierSettingFromName = function() {
    const name=String(document.getElementById('supplierSettingName')?.value||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase();
    if(!name)return;
    const supplier=supplierMasterCache.find(item =>
        String(item.supplierName||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase()===name
    );
    if(!supplier)return;
    const id=supplier.id||supplier.supplierId||'';
    const editing=document.getElementById('supplierSettingEditingSupplierId'); if(editing)editing.value=id;
    const header=document.getElementById('supplierSettingHeader'); if(header)header.value=supplier.purchaseHeaderName||supplier.supplierName||'';
    const email=document.getElementById('supplierSettingEmail'); if(email)email.value=supplier.email||'';
    const lead=document.getElementById('supplierSettingLeadTime'); if(lead)lead.value=String(Math.max(0,Number(supplier.leadTimeDays||0)));
};

window.clearSupplierSettingEditor = function() {
    ['supplierSettingEditingMappingId','supplierSettingEditingSupplierId','supplierSettingBrand','supplierSettingLine','supplierSettingName','supplierSettingHeader','supplierSettingEmail']
        .forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    const lead=document.getElementById('supplierSettingLeadTime'); if(lead)lead.value='0';
    const status=document.getElementById('supplierSettingStatus'); if(status)status.textContent='';
};

window.loadSupplierSettingToEditor = function(mappingId) {
    const mapping=supplierMappingCache.find(item=>(item.id||item.mappingId)===mappingId);
    if(!mapping)return;
    const supplier=supplierMasterCache.find(item => item.id===mapping.supplierId || item.supplierId===mapping.supplierId) || {};
    document.getElementById('supplierSettingEditingMappingId').value=mappingId;
    document.getElementById('supplierSettingEditingSupplierId').value=supplier.id||supplier.supplierId||mapping.supplierId||'';
    document.getElementById('supplierSettingBrand').value=mapping.brandName||'';
    document.getElementById('supplierSettingLine').value=mapping.productLine||'';
    document.getElementById('supplierSettingName').value=supplier.supplierName||'';
    document.getElementById('supplierSettingHeader').value=supplier.purchaseHeaderName||supplier.supplierName||'';
    document.getElementById('supplierSettingEmail').value=supplier.email||'';
    document.getElementById('supplierSettingLeadTime').value=String(Math.max(0,Number(supplier.leadTimeDays||0)));
    const status=document.getElementById('supplierSettingStatus');
    if(status)status.textContent=`正在編輯：${mapping.brandName||''} → ${supplier.supplierName||''}`;
};

window.saveSupplierSetting = async function() {
    if(!canCreatePurchaseOrderCapability())return;
    const button=actionButtonFromEventOrSelector('[onclick="saveSupplierSetting()"]');
    const state=beginActionButton(button,'儲存中…');
    if(button&&!state)return;
    const status=document.getElementById('supplierSettingStatus');
    const editingMappingId=String(document.getElementById('supplierSettingEditingMappingId')?.value||'').trim();
    const editingSupplierId=String(document.getElementById('supplierSettingEditingSupplierId')?.value||'').trim();
    const brandName=resolveBrandName(document.getElementById('supplierSettingBrand')?.value||'');
    const productLine=String(document.getElementById('supplierSettingLine')?.value||'').trim();
    const supplierName=String(document.getElementById('supplierSettingName')?.value||'').trim();
    const purchaseHeaderName=String(document.getElementById('supplierSettingHeader')?.value||'').trim()||supplierName;
    const supplierEmail=normalizeSupplierEmail(supplierMasterCache.find(item=>item.id===editingSupplierId)?.email||'');
    const leadTimeDays=Math.max(0,Math.floor(Number(document.getElementById('supplierSettingLeadTime')?.value||0)));
    if(!brandName||!supplierName){
        if(status)status.textContent=!brandName?'請選擇廠牌。':'請輸入供應商名稱。';
        endActionButton(button,state);
        return;
    }
    if(supplierEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supplierEmail)){
        if(status)status.textContent='供應商 Email 格式不正確。';
        endActionButton(button,state);
        return;
    }
    try{
        const normalizedName=supplierName.normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase();
        const sameName=supplierMasterCache.find(item =>
            String(item.supplierName||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase()===normalizedName
        );
        const editingSupplier=supplierMasterCache.find(item=>(item.id||item.supplierId)===editingSupplierId);
        const normalizedEditingName=String(editingSupplier?.supplierName||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase();
        // 若這列改成另一個供應商名稱，不直接改寫舊 Supplier Master；
        // 舊供應商可能同時被其他廠牌使用，避免一列編輯把其他廠牌的供應商一起改名。
        const supplierId=(sameName?.id||sameName?.supplierId
            ||(editingSupplier&&normalizedEditingName===normalizedName?editingSupplierId:'')
            ||stableMasterId('sup',supplierName));
        const previous=sameName
            ||(editingSupplier&&normalizedEditingName===normalizedName?editingSupplier:null)
            ||supplierMasterCache.find(item=>(item.id||item.supplierId)===supplierId);
        const mappingId=stableMasterId('bsm',brandName+'|'+(productLine||'default'));
        const now=new Date().toISOString();
        const batch=db.batch();
        batch.set(db.collection('suppliers').doc(supplierId),{
            supplierId,supplierName,purchaseHeaderName,email:supplierEmail,leadTimeDays,
            active:true,createdAt:previous?.createdAt||now,updatedAt:now
        },{merge:true});
        batch.set(db.collection('brandSupplierMappings').doc(mappingId),{
            mappingId,brandName,productLine,supplierId,isDefault:!productLine,active:true,updatedAt:now
        },{merge:true});
        if(editingMappingId&&editingMappingId!==mappingId){
            batch.set(db.collection('brandSupplierMappings').doc(editingMappingId),{active:false,updatedAt:now},{merge:true});
        }
        await batch.commit();
        supplierWarehouseLoadPromise=null;
        await loadSupplierWarehouseMasters(true);
        window.clearSupplierSettingEditor();
        if(status)status.textContent='供應商設定已儲存。';
    }catch(err){
        console.error('儲存供應商設定失敗：',err);
        if(status)status.textContent='儲存失敗：'+(err?.message||err);
    }finally{
        endActionButton(button,state);
    }
};

window.disableSupplierSetting = async function(mappingId) {
    if(!canCreatePurchaseOrderCapability()||!mappingId)return;
    const status=document.getElementById('supplierSettingStatus');
    try{
        await db.collection('brandSupplierMappings').doc(mappingId).set({active:false,updatedAt:new Date().toISOString()},{merge:true});
        supplierWarehouseLoadPromise=null;
        await loadSupplierWarehouseMasters(true);
        if(String(document.getElementById('supplierSettingEditingMappingId')?.value||'')===mappingId)window.clearSupplierSettingEditor();
        if(status)status.textContent='供應商對應已停用；供應商主檔保留供其他廠牌使用。';
    }catch(err){
        if(status)status.textContent='停用失敗：'+(err?.message||err);
    }
};

function renderWarehouseMasterAdmin() {
    const body = document.getElementById('warehouseMasterBody');
    if (!body) return;
    body.innerHTML = warehouseMasterCache.length ? warehouseMasterCache.map(item => `<tr>
        <td>${escapeHtml(item.warehouseName || '')}</td>
        <td>${item.systemCustody?'負責業務保管位置':warehouseKind(item) === 'EXTERNAL' ? '外部倉庫' : '公司倉庫'}</td>
        <td>${item.isDefault ? '是' : ''}</td>
        <td>${item.active === false ? '停用' : '啟用'}</td>
        <td>${item.systemCustody?'由交付作業維護':`<button type="button" class="btn-small btn-secondary" onclick="editWarehouseMaster(${inlineJsValue(item.id)})">編輯</button>
            <button type="button" class="btn-small btn-danger" onclick="disableWarehouseMaster(${inlineJsValue(item.id)})">停用</button>`}</td>
    </tr>`).join('') : '<tr><td colspan="5" style="color:#888;">尚未建立倉庫。</td></tr>';
}

window.editWarehouseMaster = function(id) {
    if (trueUserRole !== 'admin') return;
    const item = warehouseMasterCache.find(row => row.id === id);
    if (!item) return;
    document.getElementById('warehouseMasterEditingId').value = id;
    document.getElementById('warehouseMasterName').value = item.warehouseName || '';
    for(const [id,key] of [['warehouseMasterContact','contact'],['warehouseMasterPhone','phone'],['warehouseMasterAddress','address']]){const field=document.getElementById(id);if(field)field.value=item[key]||'';}
    document.getElementById('warehouseMasterType').value = warehouseKind(item);
    document.getElementById('warehouseMasterDefault').checked = !!item.isDefault;
    const status = document.getElementById('warehouseMasterStatus');
    if (status) status.textContent = '編輯倉庫：' + (item.warehouseName || id);
    const button = document.getElementById('warehouseMasterSaveBtn');
    if (button) button.textContent = '儲存倉庫';
};

window.clearWarehouseMasterEditor = function() {
    for (const id of ['warehouseMasterEditingId', 'warehouseMasterName','warehouseMasterContact','warehouseMasterPhone','warehouseMasterAddress']) {
        const el = document.getElementById(id);
        if (el) el.value = '';
    }
    const type = document.getElementById('warehouseMasterType');
    if (type) type.value = 'INTERNAL';
    const isDefault = document.getElementById('warehouseMasterDefault');
    if (isDefault) isDefault.checked = false;
    const button = document.getElementById('warehouseMasterSaveBtn');
    if (button) button.textContent = '＋ 新增倉庫';
};

window.clearSupplierMasterEditor = function() {
    const editing=document.getElementById('supplierMasterEditingId');
    const name=document.getElementById('supplierMasterName');
    const header=document.getElementById('supplierMasterHeader');
    const email=document.getElementById('supplierMasterEmail');
    const leadTime=document.getElementById('supplierMasterLeadTime');
    if(editing)editing.value='';
    if(name)name.value='';
    if(header)header.value='';
    if(email)email.value='';
    if(leadTime)leadTime.value='0';
};

window.loadSupplierMasterToEditor = function(id) {
    const supplier=supplierMasterCache.find(item=>(item.id||item.supplierId)===id);
    if(!supplier)return;
    document.getElementById('supplierMasterEditingId').value=id;
    document.getElementById('supplierMasterName').value=supplier.supplierName||'';
    document.getElementById('supplierMasterHeader').value=supplier.purchaseHeaderName||supplier.supplierName||'';
    document.getElementById('supplierMasterEmail').value=supplier.email||'';
    const leadTime=document.getElementById('supplierMasterLeadTime');
    if(leadTime)leadTime.value=String(Math.max(0,Number(supplier.leadTimeDays||0)));
    const status=document.getElementById('supplierMasterStatus');
    if(status)status.innerText='正在編輯：'+(supplier.supplierName||id);
};

window.saveSupplierMaster = async function() {
    if(!canCreatePurchaseOrderCapability())return;
    const button=actionButtonFromEventOrSelector('[onclick="saveSupplierMaster()"]');
    const buttonState=beginActionButton(button,'儲存中…');
    if(button&&!buttonState)return;
    const editingId=String(document.getElementById('supplierMasterEditingId')?.value||'').trim();
    const supplierName=String(document.getElementById('supplierMasterName')?.value||'').trim();
    const purchaseHeaderName=String(document.getElementById('supplierMasterHeader')?.value||'').trim()||supplierName;
    const supplierEmail=normalizeSupplierEmail(document.getElementById('supplierMasterEmail')?.value||'');
    const supplierLeadTime=Math.max(0,Math.floor(Number(document.getElementById('supplierMasterLeadTime')?.value||0)));
    const status=document.getElementById('supplierMasterStatus');
    if(!supplierName){
        if(status)status.innerText='請輸入供應商名稱。';
        endActionButton(button,buttonState);
        return;
    }
    if(supplierEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supplierEmail)){
        if(status)status.innerText='供應商 Email 格式不正確。';
        endActionButton(button,buttonState);
        return;
    }
    try{
        const duplicate=supplierMasterCache.find(item=>{
            const id=item.id||item.supplierId||'';
            if(editingId&&id===editingId)return false;
            return String(item.supplierName||'').normalize('NFKC').trim().toLocaleLowerCase()===supplierName.normalize('NFKC').trim().toLocaleLowerCase();
        });
        if(duplicate)throw new Error('已存在同名供應商，請直接編輯既有主檔。');
        const supplierId=editingId||stableMasterId('sup',supplierName);
        const previous=supplierMasterCache.find(item=>(item.id||item.supplierId)===supplierId);
        const now=new Date().toISOString();
        await db.collection('suppliers').doc(supplierId).set({
            supplierId,
            supplierName,
            purchaseHeaderName,
            email:supplierEmail,
            leadTimeDays:supplierLeadTime,
            active:true,
            createdAt:previous?.createdAt||now,
            updatedAt:now
        },{merge:true});
        supplierWarehouseLoadPromise=null;
        await loadSupplierWarehouseMasters(true);
        window.clearSupplierMasterEditor();
        if(status)status.innerText='供應商主檔已儲存。';
    }catch(err){
        if(status)status.innerText='儲存失敗：'+(err?.message||err);
    }finally{
        endActionButton(button,buttonState);
    }
};

window.disableSupplierMaster = async function(id) {
    if(!canCreatePurchaseOrderCapability()||!id)return;
    const status=document.getElementById('supplierMasterStatus');
    const activeMappings=supplierMappingCache.filter(mapping=>mapping.supplierId===id);
    if(activeMappings.length){
        if(status)status.innerText=`這個供應商仍有 ${activeMappings.length} 個廠牌／產品線對應，請先停用或改綁這些對應。`;
        return;
    }
    await db.collection('suppliers').doc(id).set({active:false,updatedAt:new Date().toISOString()},{merge:true});
    supplierWarehouseLoadPromise=null;
    await loadSupplierWarehouseMasters(true);
    if(String(document.getElementById('supplierMasterEditingId')?.value||'')===id)window.clearSupplierMasterEditor();
    if(status)status.innerText='供應商已停用。';
};

window.saveSupplierMapping = async function() {
    if(!canCreatePurchaseOrderCapability())return;
    const button=actionButtonFromEventOrSelector('[onclick="saveSupplierMapping()"]');
    const buttonState=beginActionButton(button,'儲存中…');
    if(button&&!buttonState)return;
    const brandName=resolveBrandName(document.getElementById('supplierMappingBrand')?.value||'');
    const productLine=String(document.getElementById('supplierMappingLine')?.value||'').trim();
    const supplierSelection=String(document.getElementById('supplierMappingSupplier')?.value||'').trim();
    const status=document.getElementById('supplierMappingStatus');
    const supplier=supplierMasterCache.find(item=>{
        const supplierId=item.id||item.supplierId||'';
        const normalized=supplierSelection.normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase();
        return supplierId===supplierSelection
            || String(item.supplierName||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase()===normalized
            || String(item.purchaseHeaderName||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase()===normalized;
    });
    if(!brandName||!supplier){
        if(status)status.innerText=!brandName?'請選擇廠牌。':'請選擇已建立的供應商主檔。';
        endActionButton(button,buttonState);
        return;
    }
    try{
        const supplierId=supplier.id||supplier.supplierId;
        const mappingId=stableMasterId('bsm',brandName+'|'+(productLine||'default'));
        await db.collection('brandSupplierMappings').doc(mappingId).set({
            mappingId,
            brandName,
            productLine,
            supplierId,
            isDefault:!productLine,
            active:true,
            updatedAt:new Date().toISOString()
        },{merge:true});
        supplierWarehouseLoadPromise=null;
        await loadSupplierWarehouseMasters(true);
        const supplierInput=document.getElementById('supplierMappingSupplier');
        const lineInput=document.getElementById('supplierMappingLine');
        if(supplierInput)supplierInput.value='';
        if(lineInput)lineInput.value='';
        if(status)status.innerText='廠牌與供應商對應已儲存。';
    }catch(err){
        if(status)status.innerText='儲存失敗：'+(err?.message||err);
    }finally{
        endActionButton(button,buttonState);
    }
};

window.disableSupplierMapping = async function(id) {
    if (!canCreatePurchaseOrderCapability() || !id) return;
    await db.collection('brandSupplierMappings').doc(id).set({ active:false, updatedAt:new Date().toISOString() }, { merge:true });
    supplierWarehouseLoadPromise = null;
    await loadSupplierWarehouseMasters(true);
};

window.saveWarehouseMaster = async function() {
    const status = document.getElementById('warehouseMasterStatus');
    const button = document.querySelector('[onclick="saveWarehouseMaster()"]');
    if (trueUserRole !== 'admin') {
        if (status) status.innerText = '只有管理員可以新增或修改倉庫。';
        return;
    }
    const name = String(document.getElementById('warehouseMasterName')?.value || '').trim();
    const editingId = String(document.getElementById('warehouseMasterEditingId')?.value || '').trim();
    const warehouseType = document.getElementById('warehouseMasterType')?.value === 'EXTERNAL' ? 'EXTERNAL' : 'INTERNAL';
    const makeDefault = !!document.getElementById('warehouseMasterDefault')?.checked;
    if (!name) { if (status) status.innerText = '請輸入倉庫名稱。'; return; }
    if (makeDefault && warehouseType === 'EXTERNAL') {
        if (status) status.innerText = '外部倉庫不能設為公司預設倉庫。';
        return;
    }
    if (button?.disabled) return;
    if (button) button.disabled = true;
    if (status) status.innerText = '儲存中…';
    try {
        const id = editingId || stableMasterId('wh', name);
        const previous = warehouseMasterCache.find(item => item.id === id);
        const now = new Date().toISOString();
        const values = { warehouseId:id, warehouseName:name, warehouseType, isDefault:makeDefault,
            contact:document.getElementById('warehouseMasterContact')?.value.trim()||'',phone:document.getElementById('warehouseMasterPhone')?.value.trim()||'',address:document.getElementById('warehouseMasterAddress')?.value.trim()||'',
            active:true, updatedAt:now, createdAt:previous?.createdAt || now };
        if (makeDefault) {
            const defaults = warehouseMasterCache.filter(item => item.isDefault && item.id !== id);
            const batch = db.batch();
            defaults.forEach(item => batch.set(db.collection('warehouses').doc(item.id), { isDefault:false, updatedAt:now }, { merge:true }));
            batch.set(db.collection('warehouses').doc(id), values, { merge:true });
            await batch.commit();
        } else {
            await db.collection('warehouses').doc(id).set(values, { merge:true });
        }
        supplierWarehouseLoadPromise = null;
        warehouseMasterLoadPromise = null;
        await loadSupplierWarehouseMasters(true);
        window.clearWarehouseMasterEditor();
        if (status) status.innerText = '倉庫已儲存。';
    } catch (err) {
        console.error('儲存倉庫失敗：', err);
        if (status) status.innerText = '儲存失敗：' + (err.code === 'permission-denied' ? 'Firestore 權限不足，請確認目前帳號為管理員並已部署最新 Rules。' : err.message);
    } finally {
        if (button) button.disabled = false;
    }
};

window.disableWarehouseMaster = async function(id) {
    if (trueUserRole !== 'admin' || !id) return;
    await db.collection('warehouses').doc(id).set({ active:false, isDefault:false, updatedAt:new Date().toISOString() }, { merge:true });
    supplierWarehouseLoadPromise = null;
    await loadSupplierWarehouseMasters(true);
};

function populateOrderWarehouseOptions(selected = '') {
    const field = document.getElementById('orderWarehouse');
    if (!field) return;
    const activeWarehouses = warehouseMasterCache.filter(item => item.active !== false && !item.systemCustody);
    const current = selected || field.value;
    const nextValue = activeWarehouses.some(item => item.id === current)
        ? current
        : (defaultWarehouse()?.id || activeWarehouses[0]?.id || '');

    // 此隱藏欄位僅提供初始位置提示；正式位置由預留交易確認。
    // 整個品項可由單一倉供應時會自動選倉；多倉合併仍待履約模型擴充。
    if (field.tagName === 'SELECT') {
        field.innerHTML = '<option value="">請選擇倉庫</option>' + activeWarehouses
            .map(item => `<option value="${escapeAttr(item.id)}">${escapeHtml(item.warehouseName || item.id)}${item.isDefault ? '（預設）' : ''}</option>`).join('');
    }
    field.value = nextValue;
}

const warehouseStockReadPromises = new Map();
async function warehouseStockSnapshot(productKey, warehouseId) {
    if (!productKey || !warehouseId) return null;
    const cacheKey = warehouseId + '||' + productKey;
    if (warehouseStockCache.has(cacheKey)) return warehouseStockCache.get(cacheKey);
    if (warehouseStockReadPromises.has(cacheKey)) return warehouseStockReadPromises.get(cacheKey);
    const cache = warehouseStockCache;
    const ref = db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId, productKey));
    const pending = firestoreReadWithTimeout(ref.get(), '倉庫庫存').then(snap => {
        const data = snap && snap.exists ? { id:snap.id, ...snap.data() } : null;
        if (cache === warehouseStockCache) cache.set(cacheKey, data);
        return data;
    }).finally(() => warehouseStockReadPromises.delete(cacheKey));
    warehouseStockReadPromises.set(cacheKey, pending);
    return pending;
}

// 每個提示各自追蹤查詢；切換貨號時不讓舊品項覆蓋目前結果。
const productStockHintGenerations = new WeakMap();
function clearProductStockHint(hint) {
    if (!hint) return;
    productStockHintGenerations.set(hint, (productStockHintGenerations.get(hint) || 0) + 1);
    hint.textContent = '';
    hint.hidden = true;
}

async function refreshProductStockHint(hint, productKey) {
    clearProductStockHint(hint);
    if (!hint || !productKey) return;
    const generation = productStockHintGenerations.get(hint);
    const isCurrent = () => generation === productStockHintGenerations.get(hint);
    hint.hidden = false;
    hint.textContent = '正在查詢各倉庫可用庫存…';
    try {
        await loadWarehouseMaster();
        if (!isCurrent()) return;
        if (!warehouseMasterLoadPromise) throw new Error('warehouse-master-unavailable');
        const warehouses = warehouseMasterCache.filter(warehouse => warehouse.active !== false);
        const stocks = await Promise.all(warehouses.map(warehouse => warehouseStockSnapshot(productKey, warehouse.id)));
        if (!isCurrent()) return;
        const rows = warehouses.map((warehouse, index) => {
            const onHand = Number(stocks[index]?.onHand || 0), reserved = Number(stocks[index]?.reserved || 0);
            return `${warehouse.warehouseName || warehouse.id}：${Math.max(0, onHand-reserved)} 可用（現有 ${onHand}）`;
        });
        hint.textContent = rows.length ? rows.join(' ｜ ') : '尚未建立倉庫，請洽管理員。';
    } catch (err) {
        if (isCurrent()) hint.textContent = '此品項庫存查詢失敗，請重新選取貨號重試。';
    }
}

function refreshQuoteWarehouseStock(row) {
    return refreshProductStockHint(row?.querySelector('.quote-warehouse-stock-hint'), row?.querySelector('.item-product-id')?.value || '');
}

window.refreshOrderWarehouseStock = async function() {
    const hint = document.getElementById('orderWarehouseStockHint');
    if (document.getElementById('orderFulfillmentType')?.value === 'DIRECT_SHIP') {
        clearProductStockHint(hint);
        if (hint) {
            hint.hidden = false;
            hint.textContent = '原廠直送：不預留、不入庫、不出庫；採購與銷售紀錄仍會保留。';
        }
        return;
    }
    // 使用已確認的產品身分，避免同貨號不同廠牌時誤取第一筆。
    return refreshProductStockHint(hint, window._orderModalProductId || '');
};

window.onOrderFulfillmentChange = function() {
    const type = document.getElementById('orderFulfillmentType')?.value || 'WAREHOUSE';
    refreshOrderWarehouseStock();
};


function resolveBrandName(value) {
    const input = String(value || '').trim();
    if (!input) return '';
    const key = normalizeBrandLookupKey(input);
    const defaultCanonical = defaultCanonicalBrandName(input);

    for (const entry of getUnifiedBrandEntries(true)) {
        if (normalizeBrandLookupKey(entry.name) === key) return entry.name;
        if (normalizeBrandLookupKey(entry.name) === normalizeBrandLookupKey(defaultCanonical)) return entry.name;
        if ((entry.aliases || []).some(alias => normalizeBrandLookupKey(alias) === key)) return entry.name;
    }
    return defaultCanonical;
}

function loadBrandMaster() {
    if (brandMasterLoadPromise) return brandMasterLoadPromise;
    brandMasterLoadPromise = readCollectionInBatches('brands').then(rows => {
        brandMasterCache = rows
            .map(row => normalizeBrandMasterRecord(row.id, row))
            .filter(item => item.name && item.active !== false);
        invalidateBrandDerivedCaches();
        return brandMasterCache;
    }).catch(err => {
        // 暫時失敗時保留既有資料，但不要永久記住失敗結果；下次需要時可重新連線。
        console.warn('讀取廠牌主檔失敗，暫時沿用既有廠牌設定：', err);
        brandMasterLoadPromise = null;
        return brandMasterCache;
    });
    return brandMasterLoadPromise;
}

function brandMasterDocumentId(name) {
    const normalized = normalizeBrandLookupKey(name) || 'brand';
    return encodeURIComponent(normalized).slice(0, 180);
}

async function upsertBrandMaster(name, patch = {}) {
    const canonicalName = resolveBrandName(name);
    if (!canonicalName || canonicalName === '其他' || canonicalName === OTHER_BRAND_OPTION_KEY) return;
    const id = brandMasterDocumentId(canonicalName);
    const current = brandMasterCache.find(item =>
        normalizeBrandLookupKey(defaultCanonicalBrandName(item.name)) === normalizeBrandLookupKey(canonicalName)
    );
    const payload = {
        name: canonicalName,
        aliases: patch.replaceAliases
            ? dedupeBrandsCaseInsensitive([...(patch.aliases || []), ...defaultBrandAliasesForCanonical(canonicalName)])
            : dedupeBrandsCaseInsensitive([...(current?.aliases || []), ...(patch.aliases || []), ...defaultBrandAliasesForCanonical(canonicalName)]),
        isKeyBrand: patch.isKeyBrand ?? current?.isKeyBrand ?? false,
        companies: patch.replaceCompanies
            ? [...new Set(patch.companies || [])]
            : [...new Set([...(current?.companies || []), ...(patch.companies || [])])],
        active: patch.active ?? current?.active ?? true,
        updatedAt: new Date().toISOString()
    };
    await db.collection('brands').doc(id).set(payload, { merge: true });
    const next = normalizeBrandMasterRecord(id, payload);
    const index = brandMasterCache.findIndex(item => item.id === id || normalizeBrandLookupKey(item.name) === normalizeBrandLookupKey(canonicalName));
    if (index >= 0) brandMasterCache[index] = { ...brandMasterCache[index], ...next };
    else brandMasterCache.push(next);
    invalidateBrandDerivedCaches();
}

async function syncLegacyBrandSettingsToMaster() {
    if (currentUserRole !== 'admin') return;
    const names = getUnifiedBrandNames(false);
    for (const name of names) {
        const canonical = resolveBrandName(name);
        const companies = ['yushin', 'morningstar', 'MULTI-LIFE'].filter(company =>
            includesBrandCaseInsensitive(companyAgencyBrands[company] || [], canonical)
        );
        const isKeyBrand = keyStatisticBrands.some(brand => normalizeBrandLookupKey(resolveBrandName(brand)) === normalizeBrandLookupKey(canonical));
        const aliases = keyStatisticBrandAliases[canonical] || keyStatisticBrandAliases[name] || [];
        await upsertBrandMaster(canonical, { companies, isKeyBrand, aliases, replaceCompanies: true, replaceAliases: true });
    }
}

const BRAND_AUDIT_BLOCKING_SOURCES = new Set([
    'products', 'statistics', 'companyAgencies', 'supplierMappings'
]);

function brandAuditNamesFromRecord(source, record = {}) {
    const data = record?.data || record || {};
    if (source === 'statistics' || source === 'companyAgencies') return [String(data.name || data || '')];
    if (source === 'supplierMappings') return [data.brandName || data.brand || ''];
    if (source === 'orders') return [
        data.brand || '',
        ...normalizedOrderItems(data).map(item => item.brand || '')
    ];
    if (source === 'quotes') return [
        data.brand || '',
        ...(Array.isArray(data.items) ? data.items.map(item => item.brand || '') : [])
    ];
    return [data.brand || data.brandName || ''];
}

function buildBrandMasterCompatibilityAudit(masterEntries, sources) {
    const master = (masterEntries || []).filter(entry => entry && entry.active !== false && entry.name);
    const coverage = new Map();
    master.forEach(entry => {
        [entry.name, ...(entry.aliases || [])].forEach(name => {
            const key = normalizeBrandLookupKey(name);
            if (key) coverage.set(key, entry.name);
        });
    });

    const found = new Map();
    Object.entries(sources || {}).forEach(([source, rows]) => {
        (rows || []).forEach(row => {
            brandAuditNamesFromRecord(source, row).forEach(raw => {
                const name = String(raw || '').trim();
                const key = normalizeBrandLookupKey(name);
                if (!key || ['其他', '其他廠牌'].some(skip => normalizeBrandLookupKey(skip) === key)) return;
                if (!found.has(key)) found.set(key, { name, sources: new Set(), blocking: false });
                const item = found.get(key);
                item.sources.add(source);
                if (BRAND_AUDIT_BLOCKING_SOURCES.has(source)) item.blocking = true;
            });
        });
    });

    const rows = [...found.entries()].map(([key, item]) => ({
        name: item.name,
        sources: [...item.sources].sort(),
        blocking: item.blocking,
        covered: coverage.has(key),
        canonicalName: coverage.get(key) || ''
    })).sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.name.localeCompare(b.name, 'zh-Hant'));

    return {
        masterCount: master.length,
        rows,
        missingBlocking: rows.filter(row => row.blocking && !row.covered),
        missingHistorical: rows.filter(row => !row.blocking && !row.covered),
        canRemoveCompatibilityLayer: rows.every(row => !row.blocking || row.covered)
    };
}

window.previewBrandMasterCompatibilityAudit = async function() {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') {
        alert('只有管理員可以執行廠牌主檔相容層稽核。');
        return;
    }
    const button = document.getElementById('brandMasterAuditBtn');
    const status = document.getElementById('brandMasterAuditStatus');
    if (button?.disabled) return;
    if (button) button.disabled = true;
    if (status) status.innerText = '正在讀取正式主檔與廠牌設定…';
    try {
        await Promise.all([loadBrandMaster(), loadSupplierWarehouseMasters()]);
        const sources = {
            products: (await readCollectionForMigration('products')).map(row => row.data),
            statistics: [
                ...keyStatisticBrands.map(name => ({ name })),
                ...Object.entries(keyStatisticBrandAliases).flatMap(([name, aliases]) => [
                    { name }, ...(aliases || []).map(alias => ({ name: alias }))
                ])
            ],
            companyAgencies: Object.values(companyAgencyBrands).flat().map(name => ({ name })),
            supplierMappings: supplierMappingCache
        };

        const historicalCollections = ['orders', 'quotes', 'forecasts', 'equipment'];
        for (let index = 0; index < historicalCollections.length; index++) {
            const name = historicalCollections[index];
            if (status) status.innerText = `正在分頁檢查歷史廠牌快照（${index + 1}/${historicalCollections.length}）：${name}…`;
            sources[name] = await readCollectionForMigration(name);
        }

        const report = buildBrandMasterCompatibilityAudit(brandMasterCache, sources);
        window._brandMasterCompatibilityAudit = report;
        const blockingNames = report.missingBlocking.map(row => `${row.name}（${row.sources.join('、')}）`);
        const historicalNames = report.missingHistorical.map(row => `${row.name}（${row.sources.join('、')}）`);
        const lines = [
            `廠牌主檔：${report.masterCount} 個啟用廠牌；所有來源共辨識 ${report.rows.length} 個廠牌。`,
            report.canRemoveCompatibilityLayer
                ? '正式來源檢查通過：相容層已具備移除條件。'
                : `尚不可移除相容層：${blockingNames.length} 個正式來源廠牌尚未進入廠牌主檔。`,
            blockingNames.length ? `需先補齊：${blockingNames.join('；')}` : '正式來源缺漏：0。',
            historicalNames.length
                ? `歷史快照另有 ${historicalNames.length} 個未對應名稱（不阻擋移除，但應確認是否為別名）：${historicalNames.join('；')}`
                : '歷史快照未對應名稱：0。',
            '本功能僅讀取與比對，不會修改或刪除資料。'
        ];
        if (status) status.innerText = lines.join('\n');
    } catch (err) {
        console.error('廠牌主檔相容層稽核失敗：', err);
        if (status) status.innerText = '稽核失敗：' + (err.message || err);
    } finally {
        if (button) button.disabled = false;
    }
};


function normalizeThermoBrandList(brands) {
    return dedupeBrandsCaseInsensitive((brands || []).map(value => resolveBrandName(value)).filter(Boolean));
}

function includesBrandCaseInsensitive(brands, brand) {
    const key = String(brand || '').trim().toLocaleLowerCase();
    return (brands || []).some(value => String(value || '').trim().toLocaleLowerCase() === key);
}

// 分公司代理廠牌清單裡的「其他廠牌」是特殊項目，代表這間公司是否開放「其他（自行輸入）」，不是一個真的廠牌名稱
const OTHER_BRAND_OPTION_KEY = '其他廠牌';

function isCompanyBrandAllowed(company, brand) {
    // 尚未建立設定時保留既有的全部廠牌行為。
    const normalizedBrand = String(brand || '').trim();
    if (normalizedBrand === '其他' || normalizedBrand === OTHER_BRAND_OPTION_KEY || !companyAgencyBrandsConfigured) return true;

    // 「其他」的訂單會保存使用者實際輸入的廠牌名稱，因此不能只靠品牌名稱判斷。
    // 只有明確列在任一分公司代理清單中的品牌才受公司限制；
    // 未被任何分公司列為代理品牌者，一律視為「其他廠牌」，三家公司都可發單。
    const assignedToAnyCompany = ['yushin', 'morningstar', 'MULTI-LIFE']
        .some(key => includesBrandCaseInsensitive(companyAgencyBrands[key], normalizedBrand));
    if (!assignedToAnyCompany) return true;

    return includesBrandCaseInsensitive(companyAgencyBrands[company], normalizedBrand);
}

function isCompanyOtherOptionAllowed(company) {
    return true;
}

function quoteAllowedCompaniesForBrand(brand) {
    const canonical = resolveBrandName(brand);
    if (!canonical) return [];
    return ['yushin', 'morningstar', 'MULTI-LIFE'].filter(company =>
        includesBrandCaseInsensitive(companyAgencyBrands[company] || [], canonical)
    );
}

function quoteBrandRestrictionText(brand) {
    const companies = quoteAllowedCompaniesForBrand(brand);
    if (!companies.length) return '';
    const labels = companies.map(company =>
        comparisonCompanyData[company]?.label || companyData[company]?.title || company
    );
    return '限' + labels.join('／');
}

// 估價單與訂單的人工選擇統一只列「獨立統計」主要廠牌；
 // 非主要廠牌一律走「其他廠牌」並保存實際輸入名稱，統計時仍歸入其他廠牌。
function getPrimaryBrandNames() {
    if (Array.isArray(primaryBrandNamesCache)) return [...primaryBrandNamesCache];
    const masterBrands = getUnifiedBrandEntries(false)
        .filter(entry => entry?.name && entry.active !== false && entry.isKeyBrand === true)
        .map(entry => entry.name);
    const legacyBrands = (keyStatisticBrands || [])
        .map(name => resolveBrandName(name))
        .filter(Boolean);

    primaryBrandNamesCache = dedupeBrandsCaseInsensitive([...masterBrands, ...legacyBrands])
        .filter(name => name && name !== '其他' && name !== '其他廠牌')
        .sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    return [...primaryBrandNamesCache];
}

function refreshBusinessBrandControls() {
    invalidateBrandDerivedCaches();
    populateQuoteBrandDropdowns();
    populateOrderBrandDropdown();
    populateEquipmentBrandDropdown();
    if (typeof populateForecastBrandDropdown === 'function') {
        populateForecastBrandDropdown(document.getElementById('forecastBrand')?.value || '');
    }
    if (typeof populateForecastBrandFilter === 'function') populateForecastBrandFilter();
    if (typeof populateMyQuoteBrandFilter === 'function') populateMyQuoteBrandFilter();
    if (typeof populateInventoryBrandFilter === 'function') populateInventoryBrandFilter();
    if (typeof populatePurchaserOrderFilters === 'function') populatePurchaserOrderFilters();
    if (typeof populatePurchasingFilters === 'function') populatePurchasingFilters();
    if (typeof populateEquipmentListFilters === 'function') populateEquipmentListFilters();
    if (typeof populateSalesStatisticsFilters === 'function') populateSalesStatisticsFilters();
    if (typeof window.renderProductBrandBrowser === 'function') window.renderProductBrandBrowser();
}

function brandOtherInputForSelect(select) {
    if (!select) return null;
    if (select.id === 'orderBrand') return document.getElementById('orderBrandOther');
    if (select.id === 'eqBrand') return document.getElementById('eqBrandOther');
    if (select.id === 'forecastBrand') return document.getElementById('forecastBrandOther');
    return select.closest?.('tr')?.querySelector('.item-brand-other') || null;
}

function populateBrandSelect(select, placeholderText, includeMaintenance = false, brandNames = null) {
    if (!select) return;
    const otherInput = brandOtherInputForSelect(select);
    const currentValue = select.value === '其他' ? (otherInput?.value || '其他') : select.value;
    const names = Array.isArray(brandNames) ? brandNames : getPriceListBrands(includeMaintenance);
    select.innerHTML = `<option value="">${placeholderText}</option>`;
    dedupeBrandsCaseInsensitive(names).forEach(b => {
        const opt = document.createElement('option');
        opt.value = b;
        opt.text = b;
        select.appendChild(opt);
    });
    const otherOpt = document.createElement('option');
    otherOpt.value = '其他';
    otherOpt.text = '其他廠牌（自行輸入）';
    select.appendChild(otherOpt);

    const canonical = resolveBrandName(currentValue);
    const isMain = [...select.options].some(o => o.value === canonical);
    select.value = isMain ? canonical : (currentValue ? '其他' : '');
    if (otherInput) {
        otherInput.value = !isMain && currentValue !== '其他' ? currentValue : '';
        otherInput.style.display = select.value === '其他' ? '' : 'none';
    }
}

// Product Master 若帶回非主要廠牌，不把真實名稱洗成「其他廠牌」；
// UI 顯示「其他廠牌」，實際名稱留在旁邊輸入框。
function selectBrandInDropdown(select, brandName) {
    if (!select) return;
    const otherInput = brandOtherInputForSelect(select);
    const canonical = resolveBrandName(brandName);
    if (!canonical) {
        select.value = '';
        if (otherInput) {
            otherInput.value = '';
            otherInput.style.display = 'none';
        }
        return;
    }
    const isMain = [...select.options].some(o => o.value === canonical);
    select.value = isMain ? canonical : '其他';
    if (otherInput) {
        otherInput.value = isMain ? '' : canonical;
        otherInput.style.display = isMain ? 'none' : '';
    }
}

function populateOrderBrandDropdown() {
    populateBrandSelect(document.getElementById('orderBrand'), '請選擇廠牌', true, getPrimaryBrandNames());
    onOrderBrandSelectChange();
}

function populateQuoteBrandDropdowns() {
    document.querySelectorAll('#quoteItems .item-brand').forEach(select => {
        const row = select.closest('tr');
        const currentValue = quoteRowBrandValue(row);
        populateBrandSelect(select, '廠牌（選填）', true, getPrimaryBrandNames());
        if (currentValue) selectBrandInDropdown(select, currentValue);
        onQuoteBrandSelectChange(select);
    });
}

function quoteRowBrandValue(row) {
    const select = row?.querySelector('.item-brand');
    if (!select) return '';
    const raw = select.value === '其他'
        ? String(row.querySelector('.item-brand-other')?.value || '').trim()
        : String(select.value || '').trim();
    return resolveBrandName(raw);
}

function invalidateQuoteProductIdentityIfBrandChanged(select) {
    const row = select?.closest?.('tr');
    if (!row) return;
    const productIdInput = row.querySelector('.item-product-id');
    const productId = String(productIdInput?.value || '').trim();
    const currentBrand = quoteRowBrandValue(row);
    const brandIdInput = row.querySelector('.item-brand-id');
    if (brandIdInput) brandIdInput.value = brandIdForName(currentBrand);
    if (!productId) return;
    const linkedProduct = priceList.find(item => (item.productId || stableProductId(item)) === productId);
    const linkedBrand = resolveBrandName(linkedProduct?.brand || '');
    if (linkedProduct && normalizeBrandLookupKey(currentBrand) === normalizeBrandLookupKey(linkedBrand)) return;
    if (productIdInput) productIdInput.value = '';
    clearProductStockHint(row.querySelector('.quote-warehouse-stock-hint'));
    const productLine = row.querySelector('.item-product-line');
    const productType = row.querySelector('.item-product-type');
    if (productLine) productLine.value = '';
    if (productType) productType.value = '';
}

window.onQuoteBrandSelectChange = function(select, userChanged = false) {
    const row = select?.closest?.('tr');
    if (!row) return;
    const otherInput = row.querySelector('.item-brand-other');
    if (otherInput) {
        if (select.value === '其他') {
            otherInput.style.display = '';
        } else {
            otherInput.style.display = 'none';
            otherInput.value = '';
        }
    }
    if (userChanged) {
        delete row.querySelector('.item-model')?.dataset.autofillBrand;
        invalidateQuoteProductIdentityIfBrandChanged(select);
    }
    const brand = quoteRowBrandValue(row);
    const brandIdInput = row.querySelector('.item-brand-id');
    if (brandIdInput) brandIdInput.value = brandIdForName(brand);
    const hint = row.querySelector('.quote-brand-restriction');
    if (!hint) return;
    const restriction = brand ? quoteBrandRestrictionText(brand) : '';
    const allowed = !brand || isCompanyBrandAllowed(currentCompany, brand);
    hint.textContent = restriction ? (allowed ? restriction : `${restriction}，目前公司抬頭不可使用`) : '';
    hint.classList.toggle('blocked', !!brand && !allowed);
};

window.onQuoteBrandOtherInput = function(input) {
    const row = input?.closest?.('tr');
    const select = row?.querySelector('.item-brand');
    if (!row || !select) return;
    delete row.querySelector('.item-model')?.dataset.autofillBrand;
    invalidateQuoteProductIdentityIfBrandChanged(select);
    onQuoteBrandSelectChange(select);
};

function populateEquipmentBrandDropdown() {
    populateBrandSelect(document.getElementById('eqBrand'), '請選擇廠牌', true, getPrimaryBrandNames());
    onEqBrandSelectChange();
}

// 訂單允許先選主要廠牌，或選「其他廠牌」輸入實際名稱。
function clearOrderProductIdentityKeepBrand(input) {
    if (input) {
        input.dataset.autofillStatus = '';
        input.dataset.productLine = '';
        input.dataset.productType = '';
        input.dataset.productMasterMatched = '0';
    }
    const hiddenProductLine = document.getElementById('orderProductLine');
    if (hiddenProductLine) hiddenProductLine.value = '';
    window._orderModalProductId = '';
    clearProductStockHint(document.getElementById('orderWarehouseStockHint'));
    setOrderCostFieldForProduct(null);
}

window.onOrderBrandSelectChange = function(userChanged = false) {
    const select = document.getElementById('orderBrand');
    const otherInput = document.getElementById('orderBrandOther');
    if (!select || !otherInput) return;
    if (select.value === '其他') {
        otherInput.style.display = '';
    } else {
        otherInput.style.display = 'none';
        otherInput.value = '';
    }
    if (!userChanged) return;
    const codeInput = document.getElementById('orderItemCode');
    delete codeInput?.dataset.autofillBrand;
    clearOrderProductIdentityKeepBrand(codeInput);
    const selectedBrand = getBrandFieldValue('orderBrand', 'orderBrandOther');
    if (codeInput?.value.trim() && (select.value !== '其他' || selectedBrand)) {
        onOrderItemCodeChange(codeInput);
    }
};

window.onOrderBrandOtherInput = function() {
    delete document.getElementById('orderItemCode')?.dataset.autofillBrand;
    clearOrderProductIdentityKeepBrand(document.getElementById('orderItemCode'));
};

window.onOrderBrandOtherChange = function() {
    const codeInput = document.getElementById('orderItemCode');
    if (codeInput?.value.trim() && getBrandFieldValue('orderBrand', 'orderBrandOther')) {
        onOrderItemCodeChange(codeInput);
    }
};

window.onEqBrandSelectChange = function() {
    const select = document.getElementById('eqBrand');
    const otherInput = document.getElementById('eqBrandOther');
    if (!select || !otherInput) return;
    if (select.value === '其他') {
        otherInput.style.display = '';
    } else {
        otherInput.style.display = 'none';
        otherInput.value = '';
    }
};

// 取得目前廠牌欄位真正的值：選了「其他」就取旁邊文字框的內容，否則直接取下拉選單的值
function getBrandFieldValue(selectId, otherInputId) {
    const select = document.getElementById(selectId);
    if (!select) return '';
    const raw = select.value === '其他'
        ? (document.getElementById(otherInputId)?.value || '').trim()
        : select.value.trim();
    return resolveBrandName(raw);
}

// 新增訂單與估價單共用同一套 Product Master 貨號比對；第一次開啟也會等待價格表完成載入，不需手動重新整理。
function clearOrderProductMatch(input, options = {}) {
    clearOrderProductIdentityKeepBrand(input);
    if (options.preserveBrand) return;
    const brandSelect = document.getElementById('orderBrand');
    const brandOther = document.getElementById('orderBrandOther');
    if (brandSelect) brandSelect.value = '';
    if (brandOther) { brandOther.value = ''; brandOther.style.display = 'none'; }
}

// 自動帶入的廠牌只屬於目前產品；手動選擇的廠牌才限制下一次查詢。
function productLookupBrand(input, brand) {
    return input.dataset.autofillBrand === normalizeBrandLookupKey(brand) ? '' : brand;
}

function clearChangedProductDetails(input, mode) {
    const previousCode = input.dataset.matchedProductCode || (mode === 'order' ? input.dataset.preserveOrderPriceCode : '');
    if (!previousCode || previousCode === normalizeItemCodeLoose(input.value)) return;
    const row = mode === 'quote' ? input.closest('tr') : null;
    const fields = mode === 'quote'
        ? ['.item-cn', '.item-en', '.item-spec', '.inc-price', '.ex-price', '.item-origin', '.item-lead-time']
        : ['orderItemName', 'orderItemNameEn', 'orderSpec', 'orderUnitPrice', 'orderCostPrice', 'orderSelfSupplier'];
    fields.forEach(key => {
        const field = row ? row.querySelector(key) : document.getElementById(key);
        if (field) { field.value = ''; delete field.dataset.autofillCost; }
    });
    if (input.dataset.autofillBrand) {
        const select = row ? row.querySelector('.item-brand') : document.getElementById('orderBrand');
        if (select) select.value = '';
        if (row) onQuoteBrandSelectChange(select);
        else onOrderBrandSelectChange();
    }
    delete input.dataset.autofillBrand;
    delete input.dataset.matchedProductCode;
    delete input.dataset.preserveOrderPriceCode;
    if (row) calculateTotals();
    else { orderCostRequestGeneration++; const confirmed=document.getElementById('orderSelfOrderConfirmed');if(confirmed)confirmed.value=window.defaultOrderEntrySelfOrderStatus?.()||'pending';window.syncOrderEntrySelfStatus?.();calcOrderTotal(); }
}

async function applyOrderProductMatch(input, match) {
    if (!input || !match) return;
    clearQuickProductButton(input);
    clearProductMatchChoices(input);
    input.dataset.autofillStatus = 'matched';
    input.dataset.productCheckStatus = 'matched';
    const preservePrice = input.dataset.preserveOrderPriceCode === normalizeItemCodeLoose(input.value);
    const lookupBrand = productLookupBrand(input, getBrandFieldValue('orderBrand', 'orderBrandOther'));
    input.value = match.model || input.value;
    input.dataset.matchedProductCode = normalizeItemCodeLoose(input.value);
    if (!lookupBrand) input.dataset.autofillBrand = normalizeBrandLookupKey(resolveBrandName(match.brand || ''));
    window._orderModalProductId = match.productId || stableProductId(match);
    if (match.brand) {
        selectBrandInDropdown(document.getElementById('orderBrand'), resolveBrandName(match.brand));
        onOrderBrandSelectChange();
    }
    const itemNameInput = document.getElementById('orderItemName');
    if (itemNameInput) itemNameInput.value = match.nameCn || match.nameEn || '';
    const itemNameEnInput=document.getElementById('orderItemNameEn');if(itemNameEnInput)itemNameEnInput.value=match.nameEn||'';
    const specInput=document.getElementById('orderSpec');if(specInput)specInput.value=match.spec||match.specification||'';
    const priceInput = document.getElementById('orderUnitPrice');
    if (!preservePrice && priceInput) {
        priceInput.value = match.price ?? '';
        calcOrderTotal();
    }
    input.dataset.productLine = match.productLine || '';
    input.dataset.productMasterMatched = '1';
    const hiddenProductLine = document.getElementById('orderProductLine');
    if (hiddenProductLine) hiddenProductLine.value = match.productLine || '';
    input.dataset.productType = match.productType || '';
    renderNewOrderDraftItems();
    await Promise.all([applyOrderProductCost(match), refreshOrderWarehouseStock()]);
}

let orderProductCheckGeneration = 0;
window.onOrderItemCodeChange = async function(input) {
    clearTimeout(orderItemCodeTimer);
    clearChangedProductDetails(input, 'order');
    const value = input.value.trim();
    const selectedBrand = getBrandFieldValue('orderBrand', 'orderBrandOther');
    const lookupBrand = productLookupBrand(input, selectedBrand);
    const generation = ++orderProductCheckGeneration;
    const opening = orderModalOpenGeneration;
    clearQuickProductButton(input);
    clearProductMatchChoices(input);
    if (!value) {
        clearOrderProductMatch(input, { preserveBrand:true });
        delete input.dataset.productCheckStatus;
        renderNewOrderDraftItems();
        return;
    }
    input.dataset.productCheckStatus = 'checking';
    renderNewOrderDraftItems();
    const isCurrent = () => generation === orderProductCheckGeneration && opening === orderModalOpenGeneration
        && input.value.trim() === value && getBrandFieldValue('orderBrand', 'orderBrandOther') === selectedBrand;
    try {
        const matches = await findProductsByCode(value, {throwOnError:true});
        if (!isCurrent()) return;
        const match = selectProductCodeMatch(matches, lookupBrand);
        if (!match) {
            clearOrderProductMatch(input, { preserveBrand:true });
            input.dataset.autofillStatus = 'not-found';
            const ambiguous = !lookupBrand && matches.length > 1;
            input.dataset.productCheckStatus = ambiguous ? 'ambiguous' : 'missing';
            if (ambiguous) showProductMatchChoices(input, matches, 'order');
            else showQuickProductButton(input, 'order');
            renderNewOrderDraftItems();
            return;
        }
        await applyOrderProductMatch(input, match);
    } catch (err) {
        if (!isCurrent()) return;
        input.dataset.productCheckStatus = 'error';
        renderNewOrderDraftItems();
    }
};

let orderItemCodeTimer = null;
window.onOrderItemCodeInput = function(input) {
    clearTimeout(orderItemCodeTimer);
    orderProductCheckGeneration++;
    clearChangedProductDetails(input, 'order');
    input.dataset.productCheckStatus=input.value.trim()?'checking':'';
    queueProductCodeSuggestions(input.value);
    clearOrderProductMatch(input, { preserveBrand:true });
    clearQuickProductButton(input);
    clearProductMatchChoices(input);
    const value = input.value.trim();
    renderNewOrderDraftItems();
    if (!value) return;
    orderItemCodeTimer = setTimeout(() => onOrderItemCodeChange(input), 180);
};

// 客戶名稱自動完成：僅抓「最近 10 筆」估價單取樣，避免隨估價單累積而讀取量無上限增長
window.saveToStorage = function() {
    const validDays = document.getElementById('validDays').value;
    localStorage.setItem('quote_valid_days', validDays);
};


function quoteExtraDataFromRow(row) {
    const customFields = [...row.querySelectorAll('.quote-custom-field-row')].map(fieldRow => ({
        label: String(fieldRow.querySelector('.quote-custom-label')?.value || '').trim(),
        value: String(fieldRow.querySelector('.quote-custom-value')?.value || '').trim()
    })).filter(field => field.label || field.value);
    return {
        origin: String(row.querySelector('.item-origin')?.value || '').trim(),
        leadTime: String(row.querySelector('.item-lead-time')?.value || '').trim(),
        hospitalItemCode: String(row.querySelector('.item-hospital-code')?.value || '').trim(),
        customFields
    };
}

function quoteOptionalFieldKeysFromItems(items = []) {
    const keys = new Set();
    items.forEach(item => {
        if (String(item.origin || '').trim()) keys.add('origin');
        if (String(item.leadTime || '').trim()) keys.add('leadTime');
        if (String(item.hospitalItemCode || '').trim()) keys.add('hospitalItemCode');
    });
    return [...keys];
}

function rememberQuoteCustomerPreferences(customerName, items = []) {
    const name = String(customerName || '').trim();
    const customerId = customerIdForName(name);
    if (!customerId || !currentUser || !hasBusinessCapability()) return;
    const quoteOptionalFields = quoteOptionalFieldKeysFromItems(items);
    if (!quoteOptionalFields.length) return;
    db.collection('customers').doc(customerId).set({
        customerId,
        name,
        active: true,
        // 只增加這個客戶曾經用過的欄位，不因某一張估價單少填就把既有偏好洗掉。
        quoteOptionalFields: firebase.firestore.FieldValue.arrayUnion(...quoteOptionalFields),
        updatedAt: new Date().toISOString()
    }, { merge: true }).catch(err => console.warn('客戶估價欄位偏好儲存失敗：', err));
}

function quotePreferenceCustomerName() {
    return String(
        document.getElementById('ordererName')?.value
        || document.getElementById('clientName')?.value
        || ''
    ).trim();
}

window.applyCurrentQuoteCustomerPreferences = function() {
    return applyCustomerQuotePreferences(quotePreferenceCustomerName());
};

window.applyCustomerQuotePreferences = async function(customerName) {
    const name = String(customerName || '').trim();
    activeQuoteOptionalFields = new Set();
    const customerId = customerIdForName(name);
    if (!customerId || !currentUser) return;
    try {
        const snapshot = await firestoreReadWithTimeout(
            db.collection('customers').doc(customerId).get(),
            '客戶估價偏好'
        );
        const fields = snapshot.exists && Array.isArray(snapshot.data()?.quoteOptionalFields)
            ? snapshot.data().quoteOptionalFields
            : [];
        // 估價單目前只保留仍可編輯的「更多資訊」欄位；舊偏好不再讓已移除欄位自動展開。
        const supportedFields = new Set(['origin','leadTime','hospitalItemCode']);
        activeQuoteOptionalFields = new Set(fields.filter(field => supportedFields.has(field)));
        if (!activeQuoteOptionalFields.size) return;
        document.querySelectorAll('#quoteItems tr').forEach(row => {
            const details = row.querySelector('.quote-extra-fields');
            if (details) details.open = true;
        });
    } catch (err) {
        console.warn('客戶估價欄位偏好讀取失敗：', err);
    }
};

window.addQuoteCustomField = function(button, data = {}) {
    const row = button?.closest?.('tr');
    const container = row?.querySelector('.quote-custom-fields');
    if (!container) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'quote-custom-field-row';
    wrapper.innerHTML = `
        <input type="text" class="quote-custom-label" placeholder="欄位名稱，例如：許可證字號" value="${escapeAttr(data.label || '')}">
        <input type="text" class="quote-custom-value" placeholder="內容" value="${escapeAttr(data.value || '')}">
        <button type="button" class="btn-small btn-secondary" onclick="removeQuoteCustomField(this)">移除</button>
    `;
    container.appendChild(wrapper);
};

window.removeQuoteCustomField = function(button) {
    button?.closest?.('.quote-custom-field-row')?.remove();
    saveQuoteDraft();
};

window.addQuoteRow = function(itemData = {}) {
    const tbody = document.getElementById('quoteItems');
    const rowCount = tbody.rows.length + 1;
    const tr = document.createElement('tr');

    tr.innerHTML = `
        <td data-th="項次">${rowCount}</td>
        <td>
            <div class="item-input-group">
                <div class="field-row">
                    <label>貨號：</label>
                    <input type="text" class="item-model" list="priceModelList" value="${itemData.model || ''}" oninput="onItemModelInput(this)" onchange="onItemModelChange(this)">
                </div>
                <div class="product-stock-hint quote-warehouse-stock-hint no-print" role="status" aria-live="polite" hidden></div>
                <div class="field-row">
                    <label>中文品名：</label>
                    <input type="text" class="item-cn" list="priceNameCnList" value="${itemData.nameCn || ''}" onchange="onItemCnChange(this)">
                </div>
                <div class="field-row">
                    <label>英文品名：</label>
                    <input type="text" class="item-en" list="priceNameEnList" value="${itemData.nameEn || ''}">
                </div>

                <div class="item-row-pair">
                    <div class="item-brand-field">
                        <label>廠牌：</label>
                        <select class="item-brand" onchange="onQuoteBrandSelectChange(this, true)" aria-label="估價單廠牌"><option value="">請選擇廠牌</option></select>
                        <input type="text" class="item-brand-other" placeholder="輸入實際廠牌名稱" autocomplete="off" oninput="onQuoteBrandOtherInput(this)" style="display:none;">
                        <small class="quote-brand-restriction"></small>
                        <input type="hidden" class="item-product-line" value="${escapeAttr(itemData.productLine || '')}">
                        <input type="hidden" class="item-product-type" value="${itemData.productType || ''}">
                        <input type="hidden" class="item-brand-id" value="${escapeAttr(itemData.brandId || brandIdForName(itemData.brand || ''))}">
                        <input type="hidden" class="item-product-id" value="${itemData.productId || ''}">
                    </div>
                </div>

                <div class="field-row">
                    <label>規格：</label>
                    <textarea class="item-spec" placeholder=" ">${itemData.spec || ''}</textarea>
                </div>
                <details class="quote-extra-fields no-print">
                    <summary>＋ 更多資訊</summary>
                    <div class="quote-extra-grid">
                        <label>產地<input type="text" class="item-origin" value="${escapeAttr(itemData.origin || '')}" placeholder="例如：USA"></label>
                        <label>交貨期<input type="text" class="item-lead-time" value="${escapeAttr(itemData.leadTime || '')}" placeholder="例如：下單後 4–6 週"></label>
                        <label>院內料號<input type="text" class="item-hospital-code" value="${escapeAttr(itemData.hospitalItemCode || '')}"></label>
                    </div>
                    <div class="quote-custom-fields"></div>
                    <button type="button" class="btn-small btn-secondary quote-add-custom-field" onclick="addQuoteCustomField(this)">＋ 自訂欄位</button>
                </details>
            </div>
        </td>
        <td data-th="數量"><input type="number" class="qty" value="${itemData.qty || 1}" min="1" oninput="calculateTotals()"></td>
        <td data-th="含稅單價"><input type="number" class="inc-price" value="${itemData.price || 0}" oninput="onIncPriceChange(this)"></td>
        <td data-th="未稅單價"><input type="number" class="ex-price" value="${itemData.exPrice || ((itemData.price || 0) / 1.05).toFixed(2)}" oninput="onExPriceChange(this)"></td>
        <td data-th="含稅小計"><input type="number" class="subtotal-inc" value="${itemData.subtotal || 0}" readonly style="background-color: #f9f9f9;"></td>
        <td class="no-print"><button type="button" class="btn-danger" onclick="removeQuoteRow(this)">刪除</button></td>
    `;

    tbody.appendChild(tr);
    if (itemData.model) tr.querySelector('.item-model').dataset.matchedProductCode = normalizeItemCodeLoose(itemData.model);
    refreshQuoteWarehouseStock(tr);
    const quoteBrandSelect = tr.querySelector('.item-brand');
    populateBrandSelect(quoteBrandSelect, '廠牌（選填）', true, getPrimaryBrandNames());
    if (itemData.brand) selectBrandInDropdown(quoteBrandSelect, itemData.brand);
    if (itemData.productId) tr.querySelector('.item-model').dataset.autofillBrand = normalizeBrandLookupKey(resolveBrandName(itemData.brand || ''));
    onQuoteBrandSelectChange(quoteBrandSelect);
    const extraDetails = tr.querySelector('.quote-extra-fields');
    const hasExtraData = ['origin','leadTime','hospitalItemCode'].some(key => String(itemData[key] || '').trim())
        || (Array.isArray(itemData.customFields) && itemData.customFields.length);
    if (extraDetails && (hasExtraData || activeQuoteOptionalFields.size)) extraDetails.open = true;
    const customButton = tr.querySelector('.quote-add-custom-field');
    (Array.isArray(itemData.customFields) ? itemData.customFields : []).forEach(field => addQuoteCustomField(customButton, field));
    onQuoteBrandSelectChange(tr.querySelector('.item-brand'));
    calculateTotals();
};

window.onItemCnChange = function(input) {
    const value = input.value.trim();
    const match = priceList.find(p => String(p.nameCn || '').trim() === value);
    if (!match) return;
    applyQuoteProductMatch(input.closest('tr'), match);
};

const quoteProductChecks = new WeakMap();
window.onItemModelChange = async function(input) {
    clearTimeout(quoteProductChecks.get(input)?.timer);
    clearChangedProductDetails(input, 'quote');
    const value = input.value.trim();
    const row = input.closest('tr');
    const brand = quoteRowBrandValue(row);
    const check = {};
    quoteProductChecks.set(input, check);
    clearQuickProductButton(input);
    clearProductMatchChoices(input);
    clearProductStockHint(row?.querySelector('.quote-warehouse-stock-hint'));
    ['.item-product-id', '.item-product-line', '.item-product-type'].forEach(key => {
        const field = row?.querySelector(key); if (field) field.value = '';
    });
    input.dataset.autofillStatus = value ? 'checking' : '';
    if (!value) return;
    const isCurrent = () => quoteProductChecks.get(input) === check && input.value.trim() === value
        && quoteRowBrandValue(row) === brand && row?.isConnected !== false;
    try {
        const matches = await findProductsByCode(value, {throwOnError:true});
        if (!isCurrent()) return;
        const match = selectProductCodeMatch(matches, productLookupBrand(input, brand));
        if (!match) {
            input.dataset.autofillStatus = 'not-found';
            if (matches.length > 1) showProductMatchChoices(input, matches, 'quote');
            else showQuickProductButton(input, 'quote');
            return;
        }
        input.dataset.autofillStatus = 'matched';
        applyQuoteProductMatch(row, match);
    } catch (_) {
        if (!isCurrent()) return;
        input.dataset.autofillStatus = 'error';
        const hint = row?.querySelector('.quote-warehouse-stock-hint');
        if (hint) { hint.hidden = false; hint.textContent = '產品查詢失敗，請重新輸入貨號再試一次。'; }
    }
};

window.onIncPriceChange = function(input) {
    const row = input.closest('tr');
    const incPrice = parseFloat(input.value) || 0;
    const exPriceInput = row.querySelector('.ex-price');

    exPriceInput.value = (incPrice / 1.05).toFixed(2);
    calculateTotals();
};

// 帶入舊估價單時，畫面上顯示的是那張單當初存下來的舊價格，不會自動比對現在的價目表。
// 這個功能讓使用者可以一次把整張單的品項，都重新依「貨號」→「中文品名」的順序去比對目前的價目表，
// 有找到就更新單價（連帶更新英文品名/廠牌），找不到的品項維持原樣不動，最後跳出更新結果讓使用者確認
window.refreshAllItemPricesFromPriceList = async function() {
    const rows = [...document.querySelectorAll('#quoteItems tr')];
    if (rows.length === 0) {
        alert('目前沒有任何品項可以更新。');
        return;
    }
    if (!confirm(`確定要把目前這 ${rows.length} 個品項依貨號重新比對產品主檔、更新單價嗎？\n沒有貨號或找不到唯一產品的列不會被更動。`)) return;

    let updated = 0;
    let notFound = 0;
    for (const row of rows) {
        const model = (row.querySelector('.item-model')?.value || '').trim();
        let match = model ? await findProductByCode(model) : null;
        if (!match) {
            const cn = (row.querySelector('.item-cn')?.value || '').trim();
            const nameMatches = cn ? priceList.filter(p => String(p.nameCn || '').trim() === cn) : [];
            match = nameMatches.length === 1 ? nameMatches[0] : null;
        }
        if (!match) { notFound++; continue; }
        applyQuoteProductMatch(row, match);
        updated++;
    }
    calculateTotals();
    let msg = `已更新 ${updated} 個品項。`;
    if (notFound > 0) msg += `\n有 ${notFound} 個品項找不到唯一對應產品，維持原資料。`;
    alert(msg);
};

window.onExPriceChange = function(input) {
    const row = input.closest('tr');
    const exPrice = parseFloat(input.value) || 0;
    const incPriceInput = row.querySelector('.inc-price');

    incPriceInput.value = Math.round(exPrice * 1.05 * 100) / 100;
    calculateTotals();
};

window.removeQuoteRow = function(btn) {
    const row = btn.closest('tr');
    row.remove();
    reorderRows();
    calculateTotals();
};

function reorderRows() {
    const rows = document.querySelectorAll('#quoteItems tr');
    rows.forEach((row, index) => {
        row.cells[0].innerText = index + 1;
    });
}

window.calculateTotals = function() {
    let subtotalSum = 0;
    const rows = document.querySelectorAll('#quoteItems tr');

    rows.forEach(row => {
        const qty = parseFloat(row.querySelector('.qty').value) || 0;
        const incPrice = parseFloat(row.querySelector('.inc-price').value) || 0;

        const incSubtotal = qty * incPrice;
        row.querySelector('.subtotal-inc').value = Math.round(incSubtotal);

        subtotalSum += incSubtotal;
    });

    const discountRateInput = document.getElementById('discountRateInput');
    const discountRate = parseFloat(discountRateInput.value) || 0;
    const discountedTotal = subtotalSum * (1 - discountRate / 100);

    const totalEx = discountedTotal / 1.05;
    const tax = discountedTotal - totalEx;

    document.getElementById('subtotalAmount').innerText = Math.round(totalEx).toLocaleString();
    document.getElementById('taxAmount').innerText = Math.round(tax).toLocaleString();
    document.getElementById('grandTotal').innerText = Math.round(discountedTotal).toLocaleString();
    document.getElementById('chineseTotal').innerText = `合計新台幣 ${numberToChineseWords(Math.round(discountedTotal))}元整`;

    saveQuoteDraft();
};

const QUOTE_DRAFT_STORAGE_KEY = 'quote_draft_v2';
function quoteDraftStorageKey() { return `${QUOTE_DRAFT_STORAGE_KEY}:${currentUser?.uid || 'anonymous'}`; }
let editingQuoteNo = '';

function updateQuoteEditingBanner() {
    const banner = document.getElementById('quoteEditingBanner');
    const number = document.getElementById('quoteEditingNumber');
    const saveAsNewButton = document.getElementById('saveLoadedQuoteAsNewBtn');
    if (saveAsNewButton) saveAsNewButton.style.display = editingQuoteNo ? '' : 'none';
    if (!banner || !number) return;
    if (editingQuoteNo) {
        number.innerText = editingQuoteNo;
        banner.style.display = 'flex';
    } else {
        number.innerText = '';
        banner.style.display = 'none';
    }
}

function setQuoteEditingContext(quoteNo = '') {
    editingQuoteNo = String(quoteNo || '').trim();
    updateQuoteEditingBanner();
}

function setQuoteOutputStatus(message = '', isError = false) {
    const el = document.getElementById('quoteOutputStatus');
    if (!el) return;
    el.innerText = message;
    el.classList.toggle('is-error', !!isError);
    el.style.display = message ? 'block' : 'none';
}

window.saveLoadedQuoteAsNew = async function() {
    const originalQuoteNo = editingQuoteNo || document.getElementById('quoteNo')?.value || '';
    setQuoteEditingContext('');
    initDate();
    setQuoteOutputStatus('正在建立新的估價單號…');
    await generateQuoteNo();
    saveQuoteDraft();
    setQuoteOutputStatus(`已另存為新估價單：${document.getElementById('quoteNo')?.value || ''}`);
    if (originalQuoteNo) {
        window.setTimeout(() => {
            const current = document.getElementById('quoteOutputStatus')?.innerText || '';
            if (current.startsWith('已另存為新估價單')) setQuoteOutputStatus('');
        }, 2500);
    }
};

// 把目前畫面上的估價單內容（表頭資訊＋所有品項）整份存到本機瀏覽器（localStorage），
// 這樣就算關掉分頁、關掉瀏覽器、甚至重開電腦，只要是同一台裝置、同一個瀏覽器，
// 重新打開系統時都能接著剛剛還沒印完的那張繼續打，不會憑空消失。
// 只有按「製作下一張估價單」才會真的清空、換成全新的草稿。
function saveQuoteDraft() {
    if (!currentUser) return;
    try {
        const items = Array.from(document.querySelectorAll('#quoteItems tr')).map(row => ({
            nameEn: row.querySelector('.item-en')?.value || '',
            nameCn: row.querySelector('.item-cn')?.value || '',
            model: row.querySelector('.item-model')?.value || '',
            brand: quoteRowBrandValue(row),
            productLine: row.querySelector('.item-product-line')?.value || '',
            productType: row.querySelector('.item-product-type')?.value || '',
            spec: row.querySelector('.item-spec')?.value || '',
            ...quoteExtraDataFromRow(row),
            qty: row.querySelector('.qty')?.value || '',
            price: row.querySelector('.inc-price')?.value || '',
            exPrice: row.querySelector('.ex-price')?.value || '',
            subtotal: row.querySelector('.subtotal-inc')?.value || ''
        }));

        const draft = {
            company: currentCompany,
            clientName: document.getElementById('clientName')?.value || '',
            ordererName: document.getElementById('ordererName')?.value || '',
            salesName: document.getElementById('salesName')?.value || '',
            ownerUid: document.getElementById('salesName')?.selectedOptions?.[0]?.dataset.ownerUid || '',
            quoteDate: document.getElementById('quoteDate')?.value || '',
            quoteNo: document.getElementById('quoteNo')?.value || '',
            discountRate: document.getElementById('discountRateInput')?.value || '0',
            validDays: document.getElementById('validDays')?.value || '90',
            remarks: document.getElementById('quoteRemarks')?.value || '',
            editingQuoteNo,
            items
        };
        localStorage.setItem(quoteDraftStorageKey(), JSON.stringify(draft));
    } catch (e) {
        console.error('儲存估價單草稿失敗：', e);
    }
}

function loadQuoteDraft() {
    if (!currentUser) return null;
    try {
        const raw = localStorage.getItem(quoteDraftStorageKey());
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        console.error('讀取估價單草稿失敗：', e);
        return null;
    }
}

// 把儲存的草稿套回畫面上：先套用公司主題（不重新產生單號，沿用草稿裡存的那組），
// 再逐一還原表頭欄位跟每一列品項
function restoreQuoteDraft(draft) {
    restoringQuoteDraft = true;
    applyCompanyTheme(draft.company || 'yushin');

    document.getElementById('clientName').value = draft.clientName || '';
    document.getElementById('ordererName').value = draft.ordererName || '';
    document.getElementById('quoteDate').value = draft.quoteDate || '';
    document.getElementById('discountRateInput').value = draft.discountRate || 0;
    document.getElementById('validDays').value = draft.validDays || 90;
    document.getElementById('quoteRemarks').value = draft.remarks || '';

    document.getElementById('quoteItems').innerHTML = '';
    if (draft.items && draft.items.length) {
        draft.items.forEach(item => addQuoteRow(item));
    } else {
        addQuoteRow();
    }

    // 單號沿用草稿裡存的那組，不重新產生；業務欄位要等 populateSalesDropdown 把選單填好之後才還原得了，
    // 這裡先记住待會兒要設定的值
    document.getElementById('quoteNo').value = draft.quoteNo || '';
    setQuoteEditingContext(draft.editingQuoteNo || '');
    window._pendingDraftSalesName = draft.salesName || '';
    window._pendingDraftSalesUid = draft.ownerUid || '';

    calculateTotals();
    restoringQuoteDraft = false;
}

function numberToChineseWords(num) {
    if (num === 0) return '零';
    const digit = ['零', '壹', '貳', '參', '肆', '伍', '陸', '柒', '捌', '玖'];
    const unit = ['', '拾', '佰', '仟', '萬', '拾', '佰', '仟', '億'];
    let s = '';
    let numStr = num.toString();
    for (let i = 0; i < numStr.length; i++) {
        let n = numStr[numStr.length - 1 - i];
        s = digit[n] + unit[i] + s;
    }
    return s;
}

function currentQuoteOutputValidation() {
    // 估價單與決標單價分析沒有必填欄位；空白單號、業務、品項、廠牌與金額都可直接輸出。
    // 只有「已實際填入」且違反公司報價限制的廠牌仍需阻擋，避免錯用公司抬頭。
    const rows = [...document.querySelectorAll('#quoteItems tr')];
    const hasRestrictedBrand = rows.some(row => {
        const brand = quoteRowBrandValue(row);
        return brand && !isCompanyBrandAllowed(currentCompany, brand);
    });
    if (hasRestrictedBrand) return '此估價單含有目前公司抬頭不可使用的廠牌，請改用允許的公司抬頭或更換廠牌。';
    return '';
}

function collectCurrentQuoteRecord() {
    const salesName = document.getElementById('salesName').value;
    const ownerUid = document.getElementById('salesName').selectedOptions?.[0]?.dataset.ownerUid || '';
    const selectedSales = salesList.find(s => s.uid === ownerUid && isSelectableCommercialOwner(s));
    // 負責業務可以留白；業務／工程師本人輸出時仍在背景保留自己的 ownerUid / salesCode，
    // 讓權限與歷史歸屬不因畫面欄位留白而遺失。
    const selfOwnedBlankSales = !salesName && (currentUserRole === 'sales' || currentUserRole === 'engineer');
    const resolvedSalesCode = selectedSales?.code || (selfOwnedBlankSales ? currentUserCode : '');
    const resolvedOwnerUid = selectedSales?.uid
        || (selfOwnedBlankSales
            ? (currentUser?.uid || '') : '');
    const record = {
        quoteNo: document.getElementById('quoteNo').value.trim(), company: currentCompany,
        clientName: document.getElementById('clientName').value, ordererName: document.getElementById('ordererName').value.trim(),
        salesName, salesCode: resolvedSalesCode,
        ownerUid: resolvedOwnerUid,
        quoteDate: document.getElementById('quoteDate').value, createdAt: new Date().toISOString(), ...commercialCreatorFields(),
        ...linkedDocumentFields(window._pendingForecastQuoteLink ? DOCUMENT_TYPES.FORECAST : '', window._pendingForecastQuoteLink?.forecastId || '', window._pendingForecastQuoteLink ? [documentLink(DOCUMENT_TYPES.FORECAST, window._pendingForecastQuoteLink.forecastId, 'source')] : []), validDays: document.getElementById('validDays').value,
        remarks: document.getElementById('quoteRemarks')?.value.trim() || '',
        discountRate: document.getElementById('discountRateInput').value, grandTotal: document.getElementById('grandTotal').innerText,
        items: []
    };
    document.querySelectorAll('#quoteItems tr').forEach(row => {
        const productId = row.querySelector('.item-product-id')?.value || '';
        record.items.push({
            nameEn: row.querySelector('.item-en').value, nameCn: row.querySelector('.item-cn').value,
            model: row.querySelector('.item-model').value, brand: quoteRowBrandValue(row),
            brandId: row.querySelector('.item-brand-id')?.value || brandIdForName(quoteRowBrandValue(row)),
            productLine: row.querySelector('.item-product-line').value, productType: row.querySelector('.item-product-type').value,
            productId, productMasterMatched: !!productId, spec: row.querySelector('.item-spec').value,
            ...quoteExtraDataFromRow(row), qty: row.querySelector('.qty').value,
            price: row.querySelector('.inc-price').value, exPrice: row.querySelector('.ex-price').value,
            subtotal: row.querySelector('.subtotal-inc').value
        });
    });
    record.productIds = productIdsFromItems(record.items);
    record.productMasterMatched = record.items.length > 0 && record.items.every(item => item.productMasterMatched === true);
    return record;
}

function comparisonBaseTotal() {
    return parseFloat((document.getElementById('grandTotal')?.innerText || '').replace(/,/g, '')) || 0;
}

function roundedComparisonTotal(percent) {
    return Math.ceil((comparisonBaseTotal() * (1 + Math.max(0, parseFloat(percent) || 0) / 100)) / 1000) * 1000;
}

function setComparisonCompanyOptions(select, selected, blocked) {
    const available = COMPARISON_COMPANY_ORDER.filter(key => key !== currentCompany && (key === selected || key !== blocked));
    select.innerHTML = available.map(key => `<option value="${key}" ${key === selected ? 'selected' : ''}>${escapeHtml(comparisonCompanyData[key].label)}</option>`).join('');
    if (!available.includes(selected)) select.value = available[0] || '';
}

window.openThreeQuoteDialog = function() {
    const validationMessage = currentQuoteOutputValidation();
    if (validationMessage) { alert(validationMessage); return; }
    // 使用者在選公司／比例時先把比較估價需要的 Logo 與印章載入，
    // 不把圖片下載時間留到按下「列印」之後才開始。
    preloadComparisonQuoteImages();
    const available = COMPARISON_COMPANY_ORDER.filter(key => key !== currentCompany);
    document.getElementById('comparisonPercent2').value = 10;
    document.getElementById('comparisonPercent3').value = 15;
    setComparisonCompanyOptions(document.getElementById('comparisonCompany2'), available[0] || '', available[1] || '');
    setComparisonCompanyOptions(document.getElementById('comparisonCompany3'), available[1] || available[0] || '', available[0] || '');
    updateThreeQuoteDialog();
    document.getElementById('threeQuoteOverlay').classList.add('active');
};

window.closeThreeQuoteDialog = function() {
    document.getElementById('threeQuoteOverlay').classList.remove('active');
};

window.updateThreeQuoteDialog = function() {
    const select2 = document.getElementById('comparisonCompany2');
    const select3 = document.getElementById('comparisonCompany3');
    let company2 = select2.value;
    let company3 = select3.value;
    if (company2 === company3) company3 = COMPARISON_COMPANY_ORDER.find(key => key !== currentCompany && key !== company2) || '';
    setComparisonCompanyOptions(select2, company2, company3);
    company2 = select2.value;
    setComparisonCompanyOptions(select3, company3, company2);
    const percent2 = Math.max(0, parseFloat(document.getElementById('comparisonPercent2').value) || 0);
    const percent3 = Math.max(0, parseFloat(document.getElementById('comparisonPercent3').value) || 0);
    document.getElementById('threeQuoteBaseSummary').innerHTML = `第一張：<strong>${escapeHtml(comparisonCompanyData[currentCompany]?.label || '')}</strong>／折扣後含稅總額 <strong>NT$ ${comparisonBaseTotal().toLocaleString()}</strong>`;
    document.getElementById('comparisonTotal2').innerText = `NT$ ${roundedComparisonTotal(percent2).toLocaleString()}`;
    document.getElementById('comparisonTotal3').innerText = `NT$ ${roundedComparisonTotal(percent3).toLocaleString()}`;
};

function comparisonItemsForTotal(targetTotal) {
    const discountRate = Math.max(0, parseFloat(document.getElementById('discountRateInput').value) || 0);
    const items = [...document.querySelectorAll('#quoteItems tr')].map(row => {
        const qty = parseFloat(row.querySelector('.qty').value) || 0;
        const price = parseFloat(row.querySelector('.inc-price').value) || 0;
        return {
            name: row.querySelector('.item-cn').value.trim() || row.querySelector('.item-en').value.trim(),
            model: row.querySelector('.item-model').value.trim(), qty,
            extra: quoteExtraDataFromRow(row),
            weight: Math.max(0, qty * price * (1 - discountRate / 100))
        };
    }).filter(item => item.name || item.model);
    const weightTotal = items.reduce((sum, item) => sum + item.weight, 0);
    let allocated = 0;
    return items.map((item, index) => {
        const amount = index === items.length - 1 ? targetTotal - allocated : Math.round(targetTotal * (weightTotal ? item.weight / weightTotal : 1 / items.length));
        allocated += amount;
        return { ...item, amount, unitPrice: item.qty ? amount / item.qty : 0 };
    });
}

function formatComparisonMoney(value) {
    return Number(value || 0).toLocaleString('zh-TW', { maximumFractionDigits: 4 });
}

function renderComparisonExtraFields(extra = {}, variant = 'b') {
    const labels = variant === 'a'
        ? { origin:'ORIGIN', leadTime:'LEAD TIME', hospitalItemCode:'HOSPITAL ITEM' }
        : { origin:'產地', leadTime:'交貨期', hospitalItemCode:'院內料號' };
    const rows = [
        [labels.origin, extra.origin],
        [labels.leadTime, extra.leadTime],
        [labels.hospitalItemCode, extra.hospitalItemCode],
        ...(Array.isArray(extra.customFields) ? extra.customFields.map(field => [field.label, field.value]) : [])
    ].filter(([label, value]) => String(label || '').trim() && String(value || '').trim());
    if (!rows.length) return '';
    return `<div class="comparison-product-extra">${rows.map(([label, value]) =>
        `<span><b>${escapeHtml(label)}：</b>${escapeHtml(value)}</span>`
    ).join('')}</div>`;
}

function renderComparisonQuotePage(companyKey, percent, variant) {
    const company = comparisonCompanyData[companyKey];
    const total = roundedComparisonTotal(percent);
    const items = comparisonItemsForTotal(total);
    const quoteRemarks = String(document.getElementById('quoteRemarks')?.value || '').trim();
    const showLogo = company.logo && !['yihder', 'kangning'].includes(companyKey);
    const logo = showLogo ? `<img class="comparison-company-logo" src="${escapeAttr(company.logo)}" alt="${escapeAttr(company.title)} Logo">` : '';
    const stamp = company.stamp
        ? `<img src="${escapeAttr(company.stamp)}" alt="${escapeAttr(company.title)} 估價單章">`
        : `<div class="comparison-css-stamp">${escapeHtml(company.label)}估價專用章</div>`;
    const textHeader = company.logoIsHeader && variant === 'a' && showLogo ? '' : `<h1>${escapeHtml(company.title)}</h1>${company.sub ? `<h2>${escapeHtml(company.sub)}</h2>` : ''}`;
    const headerIdentity = variant === 'b'
        ? `<div class="comparison-company-identity">${logo}<div class="comparison-company-name">${textHeader}</div></div>`
        : `${logo}${textHeader}`;
    const densityClass = items.length >= 7 ? ' comparison-quote-dense' : items.length >= 4 ? ' comparison-quote-compact' : '';
    return `<section class="comparison-quote-page comparison-style-${variant}${densityClass}">
        <header class="comparison-quote-header"><div class="comparison-company-block">${headerIdentity}${company.addr ? `<p>${escapeHtml(company.addr)}</p>` : ''}${company.contact ? `<p>${company.contact}</p>` : ''}</div>${variant === 'a' ? '<div class="comparison-document-title">QUOTATION</div>' : ''}</header>
        <div class="comparison-quote-meta">${document.getElementById('clientName').value.trim() ? `<div><span>${variant === 'a' ? 'CUSTOMER' : '抬頭'}</span><strong>${escapeHtml(document.getElementById('clientName').value)}</strong></div>` : ''}<div><span>${variant === 'a' ? 'DATE' : '報價日期'}</span><strong>${escapeHtml(document.getElementById('quoteDate').value || '')}</strong></div></div>
        <div class="comparison-product-list">${items.map(item => `<article class="comparison-product-item"><div class="comparison-product-main"><strong class="comparison-product-name">${escapeHtml(item.name || '－')}</strong><span class="comparison-product-model">${variant === 'a' ? 'MODEL' : '型號'}：${escapeHtml(item.model || '－')}</span>${renderComparisonExtraFields(item.extra, variant)}</div><span class="comparison-unit-price">${variant === 'a' ? 'UNIT' : '單價'} NT$ ${formatComparisonMoney(item.unitPrice)}</span><span class="comparison-product-qty">${variant === 'a' ? 'QTY' : '數量'} ${escapeHtml(String(item.qty || 0))}</span><strong class="comparison-product-subtotal">${variant === 'a' ? 'SUBTOTAL' : '小計'} NT$ ${formatComparisonMoney(item.amount)}</strong></article>`).join('')}</div>
        ${quoteRemarks ? `<div class="comparison-quote-remarks"><b>${variant === 'a' ? 'REMARKS' : '備註'}：</b>${escapeHtml(quoteRemarks)}</div>` : ''}
        <div class="comparison-quote-total-row"><span>${variant === 'a' ? 'TOTAL (TAX INCLUDED)' : '含稅總金額'}</span><strong>NT$ ${total.toLocaleString()}</strong></div>
        <div class="comparison-quote-chinese-total">合計新台幣 ${numberToChineseWords(total)}元整</div>
        <div class="comparison-quote-stamp">${stamp}</div>
    </section>`;
}

const quoteImagePreloadCache = new Map();

function preloadQuoteImage(src) {
    const url = String(src || '').trim();
    if (!url) return Promise.resolve(true);
    if (quoteImagePreloadCache.has(url)) return quoteImagePreloadCache.get(url);
    const promise = new Promise(resolve => {
        const img = new Image();
        let settled = false;
        const done = ok => {
            if (settled) return;
            settled = true;
            img.onload = null;
            img.onerror = null;
            resolve(ok);
        };
        img.onload = () => done(true);
        img.onerror = () => done(false);
        img.src = url;
        if (img.complete && img.naturalWidth > 0) done(true);
        window.setTimeout(() => done(img.complete && img.naturalWidth > 0), 1500);
    });
    quoteImagePreloadCache.set(url, promise);
    return promise;
}

function preloadComparisonQuoteImages() {
    const sources = new Set();
    COMPARISON_COMPANY_ORDER.forEach(key => {
        const company = comparisonCompanyData[key];
        if (company?.logo) sources.add(company.logo);
        if (company?.stamp) sources.add(company.stamp);
    });
    sources.forEach(src => preloadQuoteImage(src));
}

window.openSavedThreeQuoteRecord = async function(quoteNo) {
    const button = actionButtonFromEventOrSelector();
    const buttonState = beginActionButton(button, '載入三估單…');
    if (button && !buttonState) return;

    try {
        let source = myQuotesCache.find(q => q.quoteNo === quoteNo)
            || quoteHistorySearchResults.find(q => q.quoteNo === quoteNo);

        if (!source) {
            const snapshot = await firestoreReadWithTimeout(
                db.collection('quotes').doc(quoteNo).get(),
                '載入三估單紀錄'
            );
            if (!snapshot.exists) throw new Error('找不到這張估價單。');
            source = { id: snapshot.id, ...snapshot.data() };
        }

        const saved = source.threeQuoteRecord;
        if (!saved || !saved.baseQuote) throw new Error('這張估價單沒有已儲存的三估單紀錄。');

        await ensureSalesListLoaded();

        const baseQuote = saved.baseQuote;
        restoringQuoteDraft = true;
        actuallySwitchMainTab('quote-system');
        switchQuoteView('create', document.getElementById('qsub-create'));
        applyCompanyTheme(baseQuote.company || source.company || 'yushin');
        populateSalesDropdown();

        document.getElementById('clientName').value = baseQuote.clientName || '';
        document.getElementById('ordererName').value = baseQuote.ordererName || '';
        document.getElementById('salesName').value = baseQuote.salesName || '';
        document.getElementById('quoteDate').value = baseQuote.quoteDate || '';
        document.getElementById('quoteNo').value = baseQuote.quoteNo || quoteNo;
        setQuoteEditingContext(baseQuote.quoteNo || quoteNo);
        setQuoteOutputStatus('');
        document.getElementById('validDays').value = baseQuote.validDays ?? 90;
        document.getElementById('discountRateInput').value = baseQuote.discountRate || 0;
        document.getElementById('quoteRemarks').value = baseQuote.remarks || '';
        updateSalesPhoneDisplay();

        const itemsBody = document.getElementById('quoteItems');
        itemsBody.innerHTML = '';
        if (Array.isArray(baseQuote.items) && baseQuote.items.length) {
            baseQuote.items.forEach(item => addQuoteRow(item));
        } else {
            addQuoteRow();
        }
        calculateTotals();

        restoringQuoteDraft = false;
        saveQuoteDraft();

        preloadComparisonQuoteImages();
        const company2 = saved.company2 || '';
        const company3 = saved.company3 || '';
        setComparisonCompanyOptions(document.getElementById('comparisonCompany2'), company2, company3);
        setComparisonCompanyOptions(document.getElementById('comparisonCompany3'), company3, company2);
        document.getElementById('comparisonPercent2').value = saved.percent2 ?? 10;
        document.getElementById('comparisonPercent3').value = saved.percent3 ?? 15;
        updateThreeQuoteDialog();

        const summary = document.getElementById('threeQuoteBaseSummary');
        if (summary && saved.generatedAt) {
            const generatedAt = new Date(saved.generatedAt);
            const timeLabel = Number.isNaN(generatedAt.getTime())
                ? ''
                : generatedAt.toLocaleString('zh-TW', { hour12: false });
            summary.insertAdjacentHTML('beforeend', timeLabel ? `<br><span class="three-quote-record-time">紀錄時間：${escapeHtml(timeLabel)}</span>` : '');
        }

        document.getElementById('threeQuoteOverlay').classList.add('active');
    } catch (err) {
        console.error('載入三估單紀錄失敗：', err);
        alert('載入三估單紀錄失敗：' + (err?.message || err));
    } finally {
        restoringQuoteDraft = false;
        endActionButton(button, buttonState);
    }
};

window.printThreeQuotes = async function() {
    const validationMessage = currentQuoteOutputValidation();
    if (validationMessage) { alert(validationMessage); return; }

    const company2 = document.getElementById('comparisonCompany2').value;
    const company3 = document.getElementById('comparisonCompany3').value;
    if (!company2 || !company3 || company2 === company3 || company2 === currentCompany || company3 === currentCompany) {
        alert('三張估價單必須選擇不同公司。');
        return;
    }

    const percent2 = Math.max(0, parseFloat(document.getElementById('comparisonPercent2').value) || 0);
    const percent3 = Math.max(0, parseFloat(document.getElementById('comparisonPercent3').value) || 0);
    const button = document.getElementById('threeQuotePrintBtn');
    const originalLabel = button?.innerText || '匯出三頁 PDF';
    if (button) {
        button.disabled = true;
        button.innerText = '正在產生三頁 PDF…';
    }

    let firstStage = null;
    let comparisonStage = null;
    let quoteData = null;
    try {
        if (typeof window.html2canvas !== 'function' || !window.jspdf?.jsPDF) {
            throw new Error('PDF 元件尚未載入');
        }

        await window.DocumentDownloads.prepare('quote');
        quoteData = quoteDataForPdfExport();
        quoteData.lastOutputAt = new Date().toISOString();
        quoteData.lastOutputType = 'THREE_QUOTE_PDF';
        rememberQuoteCustomerPreferences(quoteData.ordererName || quoteData.clientName, quoteData.items);

        const baseQuoteSnapshot = JSON.parse(JSON.stringify(quoteData));
        quoteData.threeQuoteRecord = {
            version: 1,
            generatedAt: new Date().toISOString(),
            company2,
            company3,
            percent2,
            percent3,
            baseTotal: comparisonBaseTotal(),
            total2: roundedComparisonTotal(percent2),
            total3: roundedComparisonTotal(percent3),
            baseQuote: baseQuoteSnapshot
        };
        await persistQuoteOutputRecord(quoteData, '三家估價 PDF');

        const cachedIndex = myQuotesCache.findIndex(q => q.quoteNo === quoteData.quoteNo);
        if (cachedIndex >= 0) myQuotesCache[cachedIndex] = { ...myQuotesCache[cachedIndex], ...quoteData };
        const historyIndex = quoteHistorySearchResults.findIndex(q => q.quoteNo === quoteData.quoteNo);
        if (historyIndex >= 0) quoteHistorySearchResults[historyIndex] = { ...quoteHistorySearchResults[historyIndex], ...quoteData };
        writeAppDataCache('quotes', myQuotesCache);

        const first = createQuotePdfStage(quoteData);
        firstStage = first.stage;
        await waitForPdfImages(first.documentNode);

        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        const scale = isMobile ? 1.15 : 1.65;
        const firstPages = paginateQuotePdfDocument(first.stage, first.documentNode);
        await waitForPdfImages(first.stage);

        const pdf = new window.jspdf.jsPDF({ orientation:'portrait', unit:'mm', format:'a4', compress:true });
        await addDocumentPagesToPdf(pdf, firstPages, { scale, isolateRoot:firstStage });
        firstStage.remove();
        firstStage = null;

        comparisonStage = document.createElement('div');
        comparisonStage.className = 'quote-pdf-stage comparison-pdf-stage';
        comparisonStage.innerHTML =
            renderComparisonQuotePage(company2, percent2, 'a') +
            renderComparisonQuotePage(company3, percent3, 'b');
        document.body.appendChild(comparisonStage);
        await waitForPdfImages(comparisonStage);

        const comparisonPages = [...comparisonStage.querySelectorAll('.comparison-quote-page')];
        await addDocumentPagesToPdf(pdf, comparisonPages, {
            scale,
            isolateRoot:comparisonStage,
            addPageBeforeFirst: true,
            onProgress: (pageNo, pageCount) => {
                if (button) button.innerText = `正在產生三家估價單… ${pageNo}/${pageCount}`;
            }
        });

        const threeQuoteName = quotePdfFileName(quoteData).replace(/\.pdf$/i, '-三家估價.pdf');
        if (await window.DocumentDownloads.savePdf('quote', pdf, threeQuoteName) === false) {
            setQuoteOutputStatus('三家估價單已產生；已取消匯出');
            return;
        }
        setQuoteOutputStatus('✓ 三家估價單已產生並同步');
        closeThreeQuoteDialog();
    } catch (err) {
        console.error('匯出三家估價 PDF 失敗：', err);
        alert('產生三家估價 PDF 失敗：' + (err?.message || err) + '。請確認網路後再試一次。');
    } finally {
        firstStage?.remove();
        comparisonStage?.remove();
        if (button) {
            button.disabled = false;
            button.innerText = originalLabel;
        }
    }
};
function quotePdfFileName(quoteData = {}) {
    const raw = [quoteData.quoteNo, quoteData.ordererName || quoteData.clientName].filter(Boolean).join('-') || '估價單';
    return raw.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() + '.pdf';
}

function persistQuoteOutputRecord(quoteData, outputLabel = '輸出') {
    quoteData.searchTokens = buildFullHistorySearchTokens('quote', quoteData);
    const quoteRef = db.collection('quotes').doc(quoteData.quoteNo);
    const updatingExisting = !!editingQuoteNo && editingQuoteNo === quoteData.quoteNo;

    return runRoleTransaction(async transaction => {
        const snapshot = await transaction.get(quoteRef);
        if (snapshot.exists && !updatingExisting) {
            const conflict = new Error(`估價單號 ${quoteData.quoteNo} 已存在。為避免覆蓋既有估價單，請使用「另存為新估價單」取得新單號後再輸出。`);
            conflict.code = 'quote-number-conflict';
            throw conflict;
        }

        if (snapshot.exists && updatingExisting) {
            const existing = snapshot.data() || {};
            // 編輯既有估價單時，表單只代表可編輯內容；成交、三估單、文件連結等背景欄位
            // 必須由 merge 保留。建立者與建立時間也屬稽核欄位，不可因重新輸出而改寫。
            quoteData.createdAt = existing.createdAt || quoteData.createdAt;
            quoteData.createdByUid = existing.createdByUid || quoteData.createdByUid || '';
            quoteData.createdByName = existing.createdByName || quoteData.createdByName || '';
            quoteData.createdByRole = existing.createdByRole || quoteData.createdByRole || '';
            // Editing and exporting a historical quote must not silently transfer
            // ownership when its former owner no longer appears in active pickers.
            quoteData.ownerUid = existing.ownerUid || quoteData.ownerUid;
            quoteData.salesCode = existing.salesCode || quoteData.salesCode;
            if (!quoteData.salesName) quoteData.salesName = existing.salesName || '';
        }
        transaction.set(quoteRef, quoteData, { merge: true });
    }).then(() => {
        if (!editingQuoteNo) {
            setQuoteEditingContext(quoteData.quoteNo);
            saveQuoteDraft();
        }
        if (quoteData.sourceType === DOCUMENT_TYPES.FORECAST && quoteData.sourceId) {
            return db.collection('forecasts').doc(quoteData.sourceId).set({
                linkedDocuments: firebase.firestore.FieldValue.arrayUnion(documentLink(DOCUMENT_TYPES.QUOTE, quoteData.quoteNo, 'created')),
                updatedAt: new Date().toISOString()
            }, { merge: true });
        }
    }).catch(err => {
        console.error('儲存估價單到雲端失敗：', err);
        if (err?.code !== 'quote-number-conflict') {
            alert('提醒：估價單存到雲端失敗（' + err.message + '）。' + outputLabel + '內容不受影響，請稍後確認網路後再重新同步。');
        }
        throw err;
    });
}

function quoteDataForPdfExport() {
    const quoteData = collectCurrentQuoteRecord();
    const selectedSales = salesList.find(s => s.uid === quoteData.ownerUid);
    quoteData.customerId = syncCustomerMaster(quoteData.ordererName || quoteData.clientName, {
        salesCode: selectedSales?.code || quoteData.salesCode
    });
    quoteData.status = BUSINESS_STATUS.ACTIVE;
    Object.assign(quoteData, grossAmountMetadata(quoteData.grandTotal));
    return quoteData;
}

function waitForPdfImages(root) {
    const images = [...root.querySelectorAll('img')].filter(img => getComputedStyle(img).display !== 'none');
    return Promise.all(images.map(img => {
        img.loading = 'eager';
        if (img.complete && img.naturalWidth > 0) return Promise.resolve(true);
        return new Promise(resolve => {
            let settled = false;
            const done = ok => {
                if (settled) return;
                settled = true;
                img.onload = null;
                img.onerror = null;
                resolve(ok);
            };
            img.onload = () => done(true);
            img.onerror = () => done(false);
            window.setTimeout(() => done(img.complete && img.naturalWidth > 0), 700);
        });
    }));
}

function quotePdfExtraRows(item = {}) {
    return [
        ['產地', item.origin],
        ['交貨期', item.leadTime],
        ['院內料號', item.hospitalItemCode],
        ...(Array.isArray(item.customFields) ? item.customFields.map(field => [field.label, field.value]) : [])
    ].filter(([label, value]) => String(label || '').trim() && String(value || '').trim());
}

function renderQuotePdfDocument(quoteData = {}) {
    const companyKey = quoteData.company || currentCompany;
    const info = comparisonCompanyData[companyKey] || companyData[companyKey] || companyData.yushin;
    const logo = comparisonCompanyData[companyKey]?.logo || '';
    const stamp = info?.stamp || '';
    const total = parseFloat(String(quoteData.grandTotal || '0').replace(/,/g, '')) || 0;
    const subtotal = Math.round(total / 1.05);
    const tax = Math.round(total - total / 1.05);
    const discountRate = parseFloat(quoteData.discountRate) || 0;
    const validDays = String(quoteData.validDays ?? '').trim();
    const remarks = String(quoteData.remarks || '').trim();
    const selectedSales = salesList.find(s => stripPhoneSuffix(s.name) === stripPhoneSuffix(quoteData.salesName));
    const salesPhone = selectedSales?.phone || '';
    const items = Array.isArray(quoteData.items) ? quoteData.items : [];

    const root = document.createElement('div');
    root.className = `quote-pdf-document theme-${escapeAttr(companyKey)}`;
    root.innerHTML = `
        <div class="header-container">
            ${logo ? `<img class="company-logo quote-pdf-logo" src="${escapeAttr(logo)}" alt="${escapeAttr(info?.title || '')} Logo">` : ''}
            <div class="header-info">
                <h1>${escapeHtml(info?.title || '')}</h1>
                <h2>${escapeHtml(info?.sub || '')}</h2>
                ${info?.addr ? `<p>${escapeHtml(info.addr)}</p>` : ''}
                ${info?.contact ? `<p>${info.contact}</p>` : ''}
                <h2 class="quote-pdf-title">估 價 單</h2>
            </div>
        </div>
        <div class="meta-section">
            ${quoteData.clientName ? `<div class="meta-row"><label>抬頭：</label><span class="quote-pdf-value">${escapeHtml(quoteData.clientName)}</span></div>` : ''}
            <div class="meta-row-three">
                <div><label>負責業務：</label><span class="quote-pdf-value">${escapeHtml(quoteData.salesName || '')}${salesPhone ? '　' + escapeHtml(salesPhone) : ''}</span></div>
                <div><label>估價日期：</label><span class="quote-pdf-value">${escapeHtml(quoteData.quoteDate || '')}</span></div>
                <div><label>單號：</label><span class="quote-pdf-value quote-pdf-no">${escapeHtml(quoteData.quoteNo || '')}</span></div>
            </div>
        </div>
        <div class="quote-pdf-grid">
            <div class="quote-pdf-grid-row quote-pdf-grid-head">
                <div>項次</div><div>品名 / 規格 / 型號說明</div><div>數量</div><div>含稅單價</div><div>未稅單價</div><div>含稅小計</div>
            </div>
            <div class="quote-pdf-items">
                ${items.map((item, index) => {
                    const extras = quotePdfExtraRows(item);
                    return `<div class="quote-pdf-grid-row quote-pdf-item-row">
                        <div class="quote-pdf-cell quote-pdf-index">${index + 1}</div>
                        <div class="quote-pdf-cell">
                            <div class="quote-pdf-item-detail">
                                ${item.nameEn ? `<div><b>英文品名：</b>${escapeHtml(item.nameEn)}</div>` : ''}
                                ${item.nameCn ? `<div><b>中文品名：</b>${escapeHtml(item.nameCn)}</div>` : ''}
                                ${item.model ? `<div><b>貨號：</b>${escapeHtml(item.model)}</div>` : ''}
                                ${item.brand ? `<div><b>廠牌：</b>${escapeHtml(item.brand)}</div>` : ''}
                                ${item.spec ? `<div><b>規格：</b><span class="quote-pdf-prewrap">${escapeHtml(item.spec)}</span></div>` : ''}
                                ${extras.map(([label, value]) => `<div class="quote-pdf-extra"><b>${escapeHtml(label)}：</b>${escapeHtml(value)}</div>`).join('')}
                            </div>
                        </div>
                        <div class="quote-pdf-cell">${escapeHtml(String(item.qty ?? ''))}</div>
                        <div class="quote-pdf-cell">${Number(item.price || 0).toLocaleString('zh-TW', { maximumFractionDigits: 2 })}</div>
                        <div class="quote-pdf-cell">${Number(item.exPrice || 0).toLocaleString('zh-TW', { maximumFractionDigits: 2 })}</div>
                        <div class="quote-pdf-cell">${Number(item.subtotal || 0).toLocaleString('zh-TW', { maximumFractionDigits: 2 })}</div>
                    </div>`;
                }).join('')}
            </div>
        </div>
        <div class="quote-summary-block">
            ${validDays ? `<div class="footer-note">* 本估價單有效期限 ${escapeHtml(validDays)} 天。</div>` : ''}
            <div class="quote-pdf-bottom">
                <div class="quote-pdf-footer-left">
                    ${remarks ? `<div class="quote-pdf-remarks"><b>備註：</b><span>${escapeHtml(remarks)}</span></div>` : ''}
                    <div class="stamp-section">${stamp ? `<img src="${escapeAttr(stamp)}" alt="${escapeAttr(info?.title || '')} 估價單章">` : ''}</div>
                </div>
                <div class="total-section">
                    <p>銷售額合計：NT$ <span>${subtotal.toLocaleString()}</span></p>
                    <p>營業稅 (5%)：NT$ <span>${tax.toLocaleString()}</span></p>
                    ${discountRate ? `<p>優惠折扣：${discountRate}%</p>` : ''}
                    <p class="quote-pdf-grand-total">總計金額：NT$ <span>${Math.round(total).toLocaleString()}</span></p>
                    <p>合計新台幣 ${numberToChineseWords(Math.round(total))}元整</p>
                </div>
            </div>
        </div>
    `;
    return root;
}

function createQuotePdfStage(quoteData) {
    const stage = document.createElement('div');
    stage.className = 'quote-pdf-stage';
    const documentNode = renderQuotePdfDocument(quoteData);
    stage.appendChild(documentNode);
    document.body.appendChild(stage);
    return { stage, documentNode };
}

function quotePdfPageHeightPx(stage) {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;width:1px;height:277mm;';
    stage.appendChild(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    return height;
}

function createQuotePdfPage(stage, source, includeHeader = false) {
    const page = document.createElement('div');
    page.className = source.className + ' quote-pdf-page';
    if (includeHeader) {
        const header = source.querySelector('.header-container');
        const meta = source.querySelector('.meta-section');
        if (header) page.appendChild(header.cloneNode(true));
        if (meta) page.appendChild(meta.cloneNode(true));
    }

    const grid = document.createElement('div');
    grid.className = 'quote-pdf-grid';
    const head = source.querySelector('.quote-pdf-grid-head');
    if (head) grid.appendChild(head.cloneNode(true));
    const items = document.createElement('div');
    items.className = 'quote-pdf-items';
    grid.appendChild(items);
    page.appendChild(grid);
    stage.appendChild(page);
    return { page, items };
}

function paginateQuotePdfDocument(stage, source) {
    const rows = [...source.querySelectorAll('.quote-pdf-item-row')];
    const summary = source.querySelector('.quote-summary-block');
    const maxHeight = quotePdfPageHeightPx(stage);

    source.style.display = 'none';
    const pages = [];
    let current = createQuotePdfPage(stage, source, true);
    pages.push(current);

    for (const row of rows) {
        const clone = row.cloneNode(true);
        current.items.appendChild(clone);
        if (current.page.scrollHeight > maxHeight && current.items.children.length > 1) {
            clone.remove();
            current = createQuotePdfPage(stage, source, false);
            pages.push(current);
            current.items.appendChild(clone);
        }
        // 單一品項若本身超過一頁，不拆開；後續輸出會等比例縮小該頁。
    }

    if (summary) {
        const summaryClone = summary.cloneNode(true);
        current.page.appendChild(summaryClone);

        if (current.page.scrollHeight > maxHeight) {
            summaryClone.remove();
            const donor = current;
            const finalPage = createQuotePdfPage(stage, source, false);
            pages.push(finalPage);
            finalPage.page.appendChild(summaryClone);

            // 最後一頁優先放「合計整塊」，再嘗試把前一頁最後面的品項搬過來。
            // 每次搬一筆就量一次高度；放不下就立即放回原頁，避免越搬越擠。
            while (donor.items.lastElementChild) {
                const candidate = donor.items.lastElementChild;
                finalPage.items.prepend(candidate);
                if (finalPage.page.scrollHeight > maxHeight) {
                    donor.items.appendChild(candidate);
                    break;
                }
            }
        }
    }

    source.remove();
    return pages.map(entry => entry.page);
}

async function addDocumentPagesToPdf(pdf, pages, options = {}) {
    const {
        scale = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 1.15 : 1.65,
        onProgress = null,
        addPageBeforeFirst = false,
        isolateRoot = null
    } = options;
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const jpegQuality = isMobile ? 0.88 : 0.92;

    for (let index = 0; index < pages.length; index += 1) {
        if (typeof onProgress === 'function') onProgress(index + 1, pages.length);

        const page = pages[index];
        const canvas = await window.html2canvas(page, {
            backgroundColor:'#ffffff',
            scale,
            logging:false,
            useCORS:true,
            allowTaint:false,
            ignoreElements: element => !!isolateRoot && element.parentElement === document.body && element !== isolateRoot,
            imageTimeout:5000,
            width:Math.ceil(page.scrollWidth),
            height:Math.ceil(page.scrollHeight),
            windowWidth:794
        });

        if (index > 0 || addPageBeforeFirst) pdf.addPage('a4', 'p');

        const maxWidthMm = 190;
        const maxHeightMm = 277;
        const naturalHeightMm = canvas.height * maxWidthMm / canvas.width;
        const renderHeightMm = Math.min(maxHeightMm, naturalHeightMm);
        const renderWidthMm = naturalHeightMm <= maxHeightMm
            ? maxWidthMm
            : canvas.width * renderHeightMm / canvas.height;
        const x = (210 - renderWidthMm) / 2;

        // 共用 PDF 核心：估價單、三家估價單、採購單皆逐頁加入後立即釋放 Canvas。
        // 這可避免 iPhone Safari 在多頁文件上累積大型 Canvas / Base64 造成記憶體壓力。
        let imageData = canvas.toDataURL('image/jpeg', jpegQuality);
        pdf.addImage(imageData, 'JPEG', x, 10, renderWidthMm, renderHeightMm, undefined, 'FAST');
        imageData = null;
        canvas.width = 1;
        canvas.height = 1;

        if (index < pages.length - 1) {
            await new Promise(resolve => window.setTimeout(resolve, 0));
        }
    }
}

function quoteOutputCanSync(quoteData = {}) {
    if (!String(quoteData.quoteNo || '').trim()) return false;
    if (currentUserRole === 'admin') return true;
    return !!String(quoteData.ownerUid || '').trim() && !!String(quoteData.salesCode || '').trim();
}

window.exportCurrentQuotePdf = async function() {
    const validationMessage = currentQuoteOutputValidation();
    if (validationMessage) {
        alert(validationMessage);
        return;
    }

    const button = document.getElementById('printBtn');
    const originalLabel = button?.innerText || '📄 匯出 PDF（自動同步雲端）';
    if (button) {
        button.disabled = true;
        button.innerText = '正在產生 PDF…';
    }

    let stage = null;
    let pdfDownloaded = false, syncResult = null, exportFailed = false;
    const updateOutput = () => {
        if (exportFailed) return;
        setQuoteOutputStatus(pdfDownloaded
            ? (syncResult === true
                ? '✓ PDF 已產生，估價單已同步'
                : syncResult === false
                    ? 'PDF 已產生，但雲端同步失敗，請重試'
                    : syncResult === 'skipped'
                        ? '✓ PDF 已產生；此文件未設定可同步雲端的單號或資料歸屬，因此未同步'
                        : 'PDF 已產生；估價單同步中…')
            : (syncResult === false
                ? '雲端同步失敗；PDF 製作中…'
                : syncResult === true
                    ? '已同步雲端；PDF 製作中…'
                    : syncResult === 'skipped'
                        ? '沒有必填欄位；此文件將直接產生 PDF，不強制同步雲端'
                        : '估價單同步中；PDF 製作中…'), syncResult === false);
    };
    try {
        await window.DocumentDownloads.prepare('quote');
        if (typeof window.html2canvas !== 'function' || !window.jspdf?.jsPDF) {
            throw new Error('PDF 元件尚未載入');
        }

        const quoteData = quoteDataForPdfExport();
        quoteData.lastOutputAt = new Date().toISOString();
        quoteData.lastOutputType = 'PDF';
        rememberQuoteCustomerPreferences(quoteData.ordererName || quoteData.clientName, quoteData.items);
        const isNewQuote = !editingQuoteNo || editingQuoteNo !== quoteData.quoteNo;
        const canSyncQuote = quoteOutputCanSync(quoteData);
        let syncPromise;
        if (!canSyncQuote) {
            // PDF 本身沒有必填欄位；只有雲端紀錄需要安全的文件 ID 與權限歸屬。
            // 缺少這些背景識別時只略過同步，不阻擋使用者產生文件。
            syncResult = 'skipped';
            syncPromise = Promise.resolve('skipped');
            updateOutput();
        } else if (isNewQuote) {
            // 新估價單先原子確認並建立雲端文件，避免撞號時先產出一份會與舊單重號的 PDF。
            if (button) button.innerText = '正在確認估價單號…';
            await persistQuoteOutputRecord(quoteData, 'PDF');
            syncResult = true;
            syncPromise = Promise.resolve(true);
            setQuoteOutputStatus('估價單已同步；正在產生 PDF…');
        } else {
            // 已存在的估價單仍維持原本快速體驗：雲端更新與 PDF 產生平行進行。
            syncPromise = persistQuoteOutputRecord(quoteData, 'PDF')
                .then(() => {
                    syncResult = true; updateOutput();
                    return true;
                })
                .catch(() => {
                    syncResult = false; updateOutput();
                    return false;
                });
        }

        const exportDom = createQuotePdfStage(quoteData);
        stage = exportDom.stage;
        await waitForPdfImages(exportDom.documentNode);

        // 手機降低 Canvas 倍率以減少記憶體與等待時間；桌機維持較高解析度。
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        const scale = isMobile ? 1.15 : 1.65;
        // 大多數日常估價單只有一頁：先量實際排版高度，能放進 A4 就直接輸出，
        // 不再建立分頁 DOM、逐筆量高度，也不再重複等待同一批圖片。
        // 保留約 12px 安全邊界，避免 iPhone Safari 的字型/像素換算誤差造成底部裁切。
        const singlePageLimit = quotePdfPageHeightPx(stage) - 12;
        const isSinglePage = exportDom.documentNode.scrollHeight <= singlePageLimit;
        const pages = isSinglePage
            ? [exportDom.documentNode]
            : paginateQuotePdfDocument(stage, exportDom.documentNode);
        if (!isSinglePage) await waitForPdfImages(stage);

        // 單頁本身只有一張已壓縮 JPEG，關閉 jsPDF 額外 stream 壓縮可減少手機 CPU 等待；
        // 多頁仍保留原本壓縮設定，避免檔案過大。
        const pdf = new window.jspdf.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: !isSinglePage });
        await addDocumentPagesToPdf(pdf, pages, {
            scale,
            isolateRoot:stage,
            onProgress: (pageNo, pageCount) => {
                if (button) button.innerText = `正在產生 PDF… ${pageNo}/${pageCount}`;
            }
        });
        if (button) button.innerText = '正在下載 PDF…';
        if (await window.DocumentDownloads.savePdf('quote', pdf, quotePdfFileName(quoteData)) === false) {
            setQuoteOutputStatus('PDF 已產生；已取消匯出');
            return;
        }
        pdfDownloaded = true; updateOutput();
        syncPromise.then(() => {});
    } catch (err) {
        exportFailed = true;
        setQuoteOutputStatus('PDF 匯出失敗：' + (err.message || err), true);
        console.error('匯出估價單 PDF 失敗：', err);
        alert('產生估價單 PDF 失敗：' + (err?.message || err) + '。請確認網路後再試一次。');
    } finally {
        stage?.remove();
        if (button) {
            button.disabled = false;
            button.innerText = originalLabel;
        }
    }
};

window.loadQuoteFromCloud = function() {
    const qNo = document.getElementById('searchQuoteNo').value.trim();
    if (!qNo) {
        alert('請輸入要查詢的估價單號');
        return;
    }
    fetchAndFillQuote(qNo);
};

async function fetchAndFillQuote(qNo) {
    try {
        const doc = await firestoreReadWithTimeout(
            db.collection('quotes').doc(qNo).get(),
            '載入估價單'
        );
        if (!doc.exists) {
            alert('找不到該估價單');
            return;
        }
        const data = doc.data() || {};
        if (!canUseQuote(data)) {
            alert('您只能查看自己的估價單。');
            return;
        }

        if (currentUserRole === 'admin' || currentUserRole === 'purchaser') {
            await ensureSalesListLoaded();
        }
        restoringQuoteDraft = true;
        actuallySwitchMainTab('quote-system');
        switchQuoteView('create');
        applyCompanyTheme(data.company || 'yushin');
        populateSalesDropdown();

        document.getElementById('quoteNo').value = data.quoteNo || qNo;
        document.getElementById('clientName').value = data.clientName || '';
        document.getElementById('ordererName').value = data.ordererName || '';
        document.getElementById('salesName').value = data.salesName || '';
        const ownerOptionIndex = [...document.getElementById('salesName').options]
            .findIndex(option => option.dataset.ownerUid === data.ownerUid);
        if (ownerOptionIndex >= 0) document.getElementById('salesName').selectedIndex = ownerOptionIndex;
        updateSalesPhoneDisplay();
        document.getElementById('quoteDate').value = data.quoteDate || '';
        document.getElementById('validDays').value = data.validDays ?? 90;
        document.getElementById('discountRateInput').value = data.discountRate || 0;
        document.getElementById('quoteRemarks').value = data.remarks || '';
        document.getElementById('quoteItems').innerHTML = '';
        (Array.isArray(data.items) ? data.items : []).forEach(item => addQuoteRow(item));
        if (!document.getElementById('quoteItems').rows.length) addQuoteRow();
        setQuoteEditingContext(data.quoteNo || qNo);
        setQuoteOutputStatus('');
        calculateTotals();
        saveQuoteDraft();
    } catch (err) {
        console.error('無法從雲端讀取估價單：', err);
        alert('無法從雲端讀取：' + (err?.message || err));
    } finally {
        restoringQuoteDraft = false;
    }
}

window.openQuoteFromAdmin = async function(quoteNo) {
    if (!canAccessPage('quote.create')) {
        alert('您沒有權限開啟估價單。');
        return;
    }

    const button = actionButtonFromEventOrSelector();
    const buttonState = beginActionButton(button, '載入中…');
    if (button && !buttonState) return;

    try {
        // 優先使用目前列表已載入的資料，只有快取沒有時才讀 Firestore。
        // 這樣手機按「載入」時通常不需要再等一次網路。
        let source = myQuotesCache.find(q => q.quoteNo === quoteNo)
            || quoteHistorySearchResults.find(q => q.quoteNo === quoteNo);

        if (!source) {
            const snapshot = await firestoreReadWithTimeout(
                db.collection('quotes').doc(quoteNo).get(),
                '載入估價單'
            );
            if (!snapshot.exists) throw new Error('找不到這張估價單。');
            source = { id: snapshot.id, ...snapshot.data() };
        }

        if (!canUseQuote(source)) {
            throw new Error('您只能載入自己名下的估價單。');
        }

        await ensureSalesListLoaded();

        // 載入既有估價單時禁止 populateSalesDropdown / 公司切換重新產生新單號。
        restoringQuoteDraft = true;
        actuallySwitchMainTab('quote-system');
        switchQuoteView('create', document.getElementById('qsub-create'));
        applyCompanyTheme(source.company || 'yushin');
        populateSalesDropdown();

        document.getElementById('clientName').value = source.clientName || '';
        document.getElementById('ordererName').value = source.ordererName || '';
        document.getElementById('salesName').value = source.salesName || '';
        document.getElementById('quoteDate').value = source.quoteDate || '';
        document.getElementById('quoteNo').value = source.quoteNo || quoteNo;
        setQuoteEditingContext(source.quoteNo || quoteNo);
        setQuoteOutputStatus('');
        document.getElementById('validDays').value = source.validDays ?? 90;
        document.getElementById('discountRateInput').value = source.discountRate || 0;
        document.getElementById('quoteRemarks').value = source.remarks || '';
        updateSalesPhoneDisplay();

        const itemsBody = document.getElementById('quoteItems');
        itemsBody.innerHTML = '';
        if (Array.isArray(source.items) && source.items.length) {
            source.items.forEach(item => addQuoteRow(item));
        } else {
            addQuoteRow();
        }
        calculateTotals();

        restoringQuoteDraft = false;
        saveQuoteDraft();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
        console.error('載入估價單失敗：', err);
        alert('載入估價單失敗：' + (err?.message || err));
    } finally {
        restoringQuoteDraft = false;
        endActionButton(button, buttonState);
    }
};

window.copyQuoteAsNew = async function(quoteNo) {
    if (!canEditPage('quote.create')) {
        alert('您目前沒有建立估價單的權限。');
        return;
    }
    let source = myQuotesCache.find(quote => quote.quoteNo === quoteNo);
    try {
        if (!source) {
            const snapshot = await firestoreReadWithTimeout(
                db.collection('quotes').doc(quoteNo).get(),
                '複製估價單'
            );
            if (!snapshot.exists) throw new Error('找不到這張估價單。');
            source = { id: snapshot.id, ...snapshot.data() };
        }
        if (!canUseQuote(source)) {
            throw new Error('您只能複製自己的估價單。');
        }
        await ensureSalesListLoaded();
        actuallySwitchMainTab('quote-system');
        switchQuoteView('create', document.getElementById('qsub-create'));
        applyCompanyTheme(source.company || 'yushin');
        document.getElementById('clientName').value = source.clientName || '';
        document.getElementById('ordererName').value = source.ordererName || '';
        document.getElementById('discountRateInput').value = source.discountRate || 0;
        document.getElementById('validDays').value = source.validDays || 90;
        document.getElementById('quoteRemarks').value = source.remarks || '';
        initDate();

        const salesSelect = document.getElementById('salesName');
        const availableSales = [...salesSelect.options].map(option => option.value);
        if (currentUserName && availableSales.includes(currentUserName)) salesSelect.value = currentUserName;
        else if (availableSales.includes(source.salesName || '')) salesSelect.value = source.salesName;
        else salesSelect.value = '';
        updateSalesPhoneDisplay();

        const itemsBody = document.getElementById('quoteItems');
        itemsBody.innerHTML = '';
        if (Array.isArray(source.items) && source.items.length) source.items.forEach(item => addQuoteRow(item));
        else addQuoteRow();
        calculateTotals();
        setQuoteEditingContext('');
        setQuoteOutputStatus('');
        await generateQuoteNo();
        saveQuoteDraft();
    } catch (err) {
        alert('無法複製估價單：' + err.message);
    }
};

/* ---------- 我的估價單（只列出目前登入者自己名下的估價單） ---------- */
let myQuotesCache = [];
let myQuotesPaginationState = null;
let myQuotesPageLoading = false;
let myQuotesReloadRequested = false;
let quoteHistorySearchActive = false;
let quoteHistorySearchLoading = false;
let quoteHistorySearchKeyword = '';
let quoteHistorySearchResults = [];
let quoteHistorySearchTimer = null;
let quoteHistorySearchGeneration = 0;

function updateQuoteHistorySearchUi(message = '') {
    const status = document.getElementById('quoteHistorySearchStatus');
    if (status) status.innerText = message;
}

async function runQuoteHistorySearch() {
    const generation = ++quoteHistorySearchGeneration;
    const input = document.getElementById('myQuoteSearch');
    const rawKeyword = input?.value || '';
    const normalized = normalizeFullHistorySearchValue(rawKeyword);
    if (!normalized) {
        quoteHistorySearchActive = false;
        quoteHistorySearchLoading = false;
        quoteHistorySearchKeyword = '';
        quoteHistorySearchResults = [];
        updateQuoteHistorySearchUi('');
        renderMyQuotesList();
        return;
    }
    const queryToken = fullHistoryQueryToken('quote', rawKeyword);
    if (!queryToken) {
        quoteHistorySearchActive = false;
        quoteHistorySearchLoading = false;
        quoteHistorySearchResults = [];
        updateQuoteHistorySearchUi('目前帳號缺少可用的資料歸屬資訊，無法進行全歷史搜尋。');
        renderMyQuotesList();
        return;
    }

    quoteHistorySearchLoading = true;
    quoteHistorySearchActive = true;
    quoteHistorySearchKeyword = rawKeyword;
    quoteHistorySearchResults = [];
    const records = new Map();
    let cursor = null;
    let checked = 0;
    let lastIntermediateRenderAt = 0;
    updateQuoteHistorySearchUi('正在搜尋全部歷史估價單…');
    renderMyQuotesList();

    try {
        while (true) {
            let query = scopedHistorySearchQuery('quotes', queryToken).limit(DEFAULT_LIST_LIMIT);
            if (cursor) query = query.startAfter(cursor);
            const snapshot = await firestoreReadWithTimeout(query.get(), '估價單索引搜尋');
            if (generation !== quoteHistorySearchGeneration) return;

            checked += snapshot.size;
            snapshot.forEach(doc => {
                const data = { id: doc.id, ...doc.data() };
                if (fullHistoryRecordMatches('quote', data, rawKeyword)) records.set(doc.id, data);
            });
            const now = Date.now();
            if (now - lastIntermediateRenderAt >= 100 || snapshot.size < DEFAULT_LIST_LIMIT) {
                lastIntermediateRenderAt = now;
                quoteHistorySearchResults = [...records.values()]
                    .sort((a,b)=>compareBusinessRecordsNewestFirst(a,b,'quoteDate','quoteNo'));
                renderMyQuotesList();
            }
            updateQuoteHistorySearchUi(`全歷史搜尋中：已檢查 ${checked} 筆候選資料，找到 ${records.size} 筆…`);

            if (snapshot.size < DEFAULT_LIST_LIMIT) {
                break;
            }
            cursor = snapshot.docs[snapshot.docs.length - 1];
            await Promise.resolve();
        }
        if (generation !== quoteHistorySearchGeneration) return;
        quoteHistorySearchResults = [...records.values()]
            .sort((a,b)=>compareBusinessRecordsNewestFirst(a,b,'quoteDate','quoteNo'));
        updateQuoteHistorySearchUi(`全歷史搜尋完成：找到 ${records.size} 筆`);
    } catch (err) {
        if (generation !== quoteHistorySearchGeneration) return;
        console.error('估價單全歷史搜尋失敗：', err);
        quoteHistorySearchActive = false;
        quoteHistorySearchResults = [];
        updateQuoteHistorySearchUi('全歷史搜尋索引尚未補齊，請管理員到資料庫管理執行搜尋索引補建。');
        renderMyQuotesList();
    } finally {
        if (generation === quoteHistorySearchGeneration) {
            quoteHistorySearchLoading = false;
            renderMyQuotesList();
        }
    }
}

window.scheduleQuoteHistorySearch = function() {
    clearTimeout(quoteHistorySearchTimer);
    const keyword = document.getElementById('myQuoteSearch')?.value || '';
    if (!normalizeFullHistorySearchValue(keyword)) return runQuoteHistorySearch();
    quoteHistorySearchTimer = scheduleListSearch(quoteHistorySearchTimer, () => runQuoteHistorySearch(), 500);
};

window.clearQuoteHistorySearch = function() {
    clearTimeout(quoteHistorySearchTimer);
    quoteHistorySearchGeneration++;
    quoteHistorySearchLoading = false;
    quoteHistorySearchActive = false;
    quoteHistorySearchKeyword = '';
    quoteHistorySearchResults = [];
    const input = document.getElementById('myQuoteSearch');
    if (input) input.value = '';
    updateQuoteHistorySearchUi('');
    renderMyQuotesList();
};

window.switchQuoteView = function(view, el, options = {}) {
    const pageKey = view === 'create' ? 'quote.create' : 'quote.my';
    const previousView = document.getElementById('myQuotesPanel')?.style.display === 'block' ? 'my' : 'create';
    if (!options.skipHistory && previousView !== view) pushAppNavigationState({ tabId: 'quote-system', quoteView: view });
    if (!canAccessPage(pageKey)) { alert('您沒有權限查看這個分頁。'); return; }
    document.querySelectorAll('#quote-system > .sub-nav .sub-tab').forEach(t => t.classList.remove('active'));
    const targetEl = el || document.getElementById(view === 'create' ? 'qsub-create' : 'qsub-my');
    if (targetEl) targetEl.classList.add('active');

    document.getElementById('quoteCreatePanel').style.display = view === 'create' ? 'block' : 'none';
    document.getElementById('myQuotesPanel').style.display = view === 'my' ? 'block' : 'none';

    if (view === 'my' && !options.skipReload && myQuotesCache.length === 0) {
        loadMyQuotesFromCloud();
    }
    if (view === 'my' && canViewAllData('quotes')) {
        ensureSalesListLoaded().then(() => {
            if (document.getElementById('myQuotesPanel')?.style.display === 'block') renderMyQuotesList();
        }).catch(err => console.warn('業務名單載入失敗：', err));
    }
    updateReadonlyNotice();
};

function createMyQuotesPaginationState() {
    const sources = [];
    if (canViewAllData('quotes')) {
        // 全公司估價單直接由 Firestore 依日期分頁，不能先按公司／單號分組後才在前端重排。
        sources.push({ cursor: null, query: () => db.collection('quotes').orderBy('quoteDate', 'desc') });
    } else {
        if (currentUserCode) sources.push({ cursor: null, query: () => db.collection('quotes').where('salesCode', '==', currentUserCode).orderBy('quoteDate', 'desc') });
        if (currentUser?.uid) sources.push({ cursor: null, query: () => db.collection('quotes').where('ownerUid', '==', currentUser.uid).orderBy('quoteDate', 'desc') });

    }
    return { sources, sourceIndex: 0 };
}

function updateMyQuotesLoadMoreButton() {
    const button = document.getElementById('myQuotesLoadMoreBtn');
    const refreshButton = document.getElementById('quoteHistoryRefreshBtn');
    const hasMore = !!myQuotesPaginationState && myQuotesPaginationState.sourceIndex < myQuotesPaginationState.sources.length;
    if (button) {
        button.style.display = hasMore ? '' : 'none';
        button.disabled = myQuotesPageLoading;
        button.innerText = myQuotesPageLoading ? '載入中…' : '載入更多（每次 50 筆）';
    }
    if (refreshButton) {
        refreshButton.disabled = myQuotesPageLoading;
        refreshButton.textContent = myQuotesPageLoading ? '更新中…' : '↻ 更新';
    }
}

async function loadMyQuotesPage(reset) {
    const hint = document.getElementById('myQuotesEmptyHint');
    if (myQuotesPageLoading) {
        if (reset) myQuotesReloadRequested = true;
        return;
    }
    if (getDataScope('quotes') === 'none') {
        myQuotesCache = [];
        myQuotesPaginationState = null;
        document.getElementById('myQuotesBody').innerHTML = '';
        hint.style.display = 'block';
        hint.innerText = '管理員尚未設定此身份的估價單資料查看範圍。';
        updateMyQuotesLoadMoreButton();
        return;
    }
    if (reset || !myQuotesPaginationState) {
        myQuotesPaginationState = createMyQuotesPaginationState();
    }
    myQuotesPageLoading = true;
    const requestedRole = currentUserRole, requestedUid = currentUser?.uid;
    updateMyQuotesLoadMoreButton();
    // 重新整理時保留目前畫面，背景抓到新資料後再一次替換，避免每次先清空造成長時間白畫面。
    const records = new Map(reset ? [] : myQuotesCache.map(quote => [quote.id, quote]));
    let remainingReads = DEFAULT_LIST_LIMIT;
    try {
        while (remainingReads > 0 && myQuotesPaginationState.sourceIndex < myQuotesPaginationState.sources.length) {
            const source = myQuotesPaginationState.sources[myQuotesPaginationState.sourceIndex];
            const requested = remainingReads;
            let query = source.query().limit(requested);
            if (source.cursor) query = query.startAfter(source.cursor);
            const snapshot = await firestoreReadWithTimeout(query.get(), '估價單');
            if (requestedRole !== currentUserRole || requestedUid !== currentUser?.uid) {
                myQuotesReloadRequested = true;
                return;
            }
            if (!snapshot.empty) {
                source.cursor = snapshot.docs[snapshot.docs.length - 1];
                snapshot.forEach(doc => records.set(doc.id, { id: doc.id, ...doc.data() }));
                myQuotesCache = [...records.values()];
            }
            remainingReads -= snapshot.size;
            if (snapshot.size < requested) myQuotesPaginationState.sourceIndex++;
        }
        myQuotesCache.sort((a, b) => compareBusinessRecordsNewestFirst(a, b, 'quoteDate', 'quoteNo'));
        writeAppDataCache('quotes', myQuotesCache);
        renderMyQuotesList();
        if (!currentUserName && myQuotesCache.length === 0) {
            hint.style.display = 'block';
            hint.innerText = '目前找不到以此帳號建立的新式紀錄。若要顯示舊估價單，請管理員在 users 帳號資料補上姓名，以便比對舊資料的負責業務。';
        }
    } catch (err) {
        if(requestedRole!==currentUserRole||requestedUid!==currentUser?.uid)return;
        mainPageLoadFailed('quote');
        console.error(err);
        myQuotesCache = [...records.values()].sort((a, b) => compareBusinessRecordsNewestFirst(a, b, 'quoteDate', 'quoteNo'));
        renderMyQuotesList();
        alert(err?.code === 'firestore-read-timeout'
            ? '估價單資料讀取逾時，請稍候片刻後再試。'
            : '讀取估價單失敗，請確認網路或 Firestore 權限設定。');
    } finally {
        myQuotesPageLoading = false;
        if(requestedRole===currentUserRole&&requestedUid===currentUser?.uid)renderMyQuotesList();
        updateMyQuotesLoadMoreButton();
        if (myQuotesReloadRequested) {
            myQuotesReloadRequested = false;
            loadMyQuotesPage(true);
        }
    }
}

window.loadMyQuotesFromCloud = function() {
    return loadMyQuotesPage(true);
};

window.loadMoreMyQuotes = function() {
    return loadMyQuotesPage(false);
};

function quoteBrandsForRecord(quote = {}) {
    return dedupeBrandsCaseInsensitive((quote.items || [])
        .map(item => resolveBrandName(item.brand || ''))
        .filter(Boolean));
}

let myQuoteBrandFilterSignature = '';
let myQuoteSalesFilterSignature = '';

function populateMyQuoteBrandFilter(source = []) {
    const select = document.getElementById('myQuoteBrandFilter');
    if (!select) return;
    const selected = select.value;
    const brandNames = getPrimaryBrandNames();
    const signature = JSON.stringify(brandNames);
    if (signature !== myQuoteBrandFilterSignature) {
        select.innerHTML = '<option value="">全部廠牌</option>' + brandNames
            .map(brand => `<option value="${escapeAttr(brand)}">${escapeHtml(brand)}</option>`).join('')
            + `<option value="${OTHER_BRAND_OPTION_KEY}">其他廠牌</option>`;
        myQuoteBrandFilterSignature = signature;
    }
    if (brandNames.includes(selected) || selected === OTHER_BRAND_OPTION_KEY) select.value = selected;
    else if (selected) select.value = '';
}

function populateMyQuoteSalesFilter() {
    const select = document.getElementById('myQuoteSalesFilter');
    if (!select) return;
    const canSeeAll = canViewAllData('quotes');
    select.style.display = canSeeAll ? '' : 'none';
    if (!canSeeAll) { select.value = ''; return; }
    const selected = select.value;
    const names = [...new Set([
        ...salesList.filter(isSelectableCommercialOwner).map(person => stripPhoneSuffix(person.name || '')),
        ...myQuotesCache.map(quote => stripPhoneSuffix(quote.salesName || '')),
        ...quoteHistorySearchResults.map(quote => stripPhoneSuffix(quote.salesName || ''))
    ].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    const signature = JSON.stringify(names);
    if (signature !== myQuoteSalesFilterSignature) {
        select.innerHTML = '<option value="">全部負責業務</option>' + names.map(name =>
            `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`).join('');
        myQuoteSalesFilterSignature = signature;
    }
    if (names.includes(selected)) select.value = selected;
    else if (selected) select.value = '';
}

window.renderMyQuotesList = function() {
    const tbody = document.getElementById('myQuotesBody');
    const searchInput = document.getElementById('myQuoteSearch');
    const keyword = (searchInput.value || '').toLowerCase();
    const periodFilter = document.getElementById('myQuotePeriodFilter')?.value || 'this-year';
    const statusFilter = document.getElementById('myQuoteStatusFilter')?.value || '';
    tbody.innerHTML = '';
    const fragment = document.createDocumentFragment();
    let shown = 0;

    const isAdminViewingAll = canViewAllData('quotes');
    const visibleQuoteSource = quoteHistorySearchActive ? quoteHistorySearchResults : myQuotesCache;
    populateMyQuoteSalesFilter();
    populateMyQuoteBrandFilter(visibleQuoteSource);
    const salesFilter = document.getElementById('myQuoteSalesFilter')?.value || '';
    const brandFilter = document.getElementById('myQuoteBrandFilter')?.value || '';
    const selectableBrands = getPrimaryBrandNames();
    const salesHeader = document.getElementById('myQuotesSalesHeader');
    if (salesHeader) salesHeader.style.display = isAdminViewingAll ? '' : 'none';

    visibleQuoteSource.forEach(q => {
        if (!quoteHistorySearchActive && keyword) {
            const itemSearchText = (q.items || []).map(item =>
                `${item.brand || ''} ${item.model || ''} ${item.nameCn || ''} ${item.nameEn || ''} ${item.spec || ''}`
            ).join(' ');
            const searchable = `${q.quoteNo || ''} ${q.clientName || ''} ${q.ordererName || ''} ${q.salesName || ''} ${itemSearchText}`.toLowerCase();
            if (!searchable.includes(keyword)) return;
        }
        if (salesFilter && stripPhoneSuffix(q.salesName || '') !== salesFilter) return;
        if (brandFilter && !quoteBrandsForRecord(q).some(brand => orderBrandFilterValue(brand, selectableBrands) === brandFilter)) return;
        if (statusFilter === 'open' && q.dealClosed) return;
        if (statusFilter === 'deal' && !q.dealClosed) return;
        if (!dateInUnifiedPeriod(q.quoteDate || q.createdAt, periodFilter)) return;
        shown++;

        const tr = document.createElement('tr');
        bindListRowSelection(tr);

        // --- 修改這裡：根據狀態顯示不同按鈕 ---
        const statusBadges = [];
        if (q.dealClosed) {
            statusBadges.push('<span class="quote-status-badge is-deal">已成交</span>');
            if (q.threeQuoteRecord) statusBadges.push('<span class="quote-status-badge is-three">三估單</span>');
        } else {
            statusBadges.push('<span class="quote-status-badge is-quoted">已報價</span>');
            if (q.threeQuoteRecord) statusBadges.push('<span class="quote-status-badge is-three">三估單</span>');
        }
        const statusCell = `<div class="quote-status-badges">${statusBadges.join('')}</div>`;

        const dealButton = q.dealClosed || (currentUserRole==='engineer' && !belongsToCurrentUser(q.salesName,q.ownerUid,q.salesCode))
            ? ''
            : `<button type="button" class="btn-small quote-primary-deal" onclick="markQuoteAsDeal(${inlineJsValue(q.quoteNo)})">✓ 成交</button>`;
        // ------------------------------------

        tr.innerHTML = `
            <td data-th="估價單號">${escapeHtml(q.quoteNo || '')}</td>
            <td data-th="抬頭">${escapeHtml(q.clientName || '')}</td>
            <td data-th="客戶名稱">${escapeHtml(q.ordererName || '')}</td>
            ${isAdminViewingAll ? `<td data-th="業務">${escapeHtml(stripPhoneSuffix(q.salesName))}</td>` : ''}
            <td data-th="日期">${escapeHtml(q.quoteDate || '')}</td>
            <td data-th="金額">${escapeHtml(q.grandTotal || '')}</td>
            <td data-th="狀態">${statusCell}</td>
            <td class="no-print quote-list-actions">
                <div class="quote-list-action-row">
                    <button type="button" class="btn-small" onclick="openQuoteFromAdmin(${inlineJsValue(q.quoteNo)})">載入</button>
                    ${dealButton}
                    <details class="quote-more-menu">
                        <summary class="btn-small btn-secondary">更多功能</summary>
                        <div class="quote-more-menu-popover">
                            ${q.threeQuoteRecord ? `<button type="button" onclick="openSavedThreeQuoteRecord(${inlineJsValue(q.quoteNo)})">三估單</button>` : ''}
                            <button type="button" onclick="copyQuoteAsNew(${inlineJsValue(q.quoteNo)})">複製成新估價單</button>
                            ${canEditPage('forecast') ? `<button type="button" onclick="createForecastFromQuote(${inlineJsValue(q.quoteNo)})">建立 Forecast</button>` : ''}
                            ${q.dealClosed && canManageOrderLifecycleCapability() && (currentUserRole === 'admin' || belongsToCurrentUser(q.salesName,q.ownerUid,q.salesCode)) ? `<button type="button" onclick="unmarkQuoteAsDeal(${inlineJsValue(q.quoteNo)})">取消成交</button>` : ''}
                            ${trueUserRole === 'admin' && currentUserRole === 'admin' ? `<button type="button" class="danger-menu-item" onclick="permanentlyDeleteQuote(${inlineJsValue(q.quoteNo)})">永久刪除</button>` : ''}
                        </div>
                    </details>
                </div>
            </td>
        `;
        fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);

    document.getElementById('myQuotesEmptyHint').style.display = shown === 0 ? 'block' : 'none';
    document.getElementById('myQuotesEmptyHint').textContent = quoteHistorySearchLoading || myQuotesPageLoading ? '正在讀取估價單…' : '查無符合條件的估價單。';
};

// 成交：標記估價單為已成交，並把裡面每一個品項匯入訂單管理系統（一次性動作，避免重複匯入）
window.createForecastFromQuote = async function(quoteNo) {
    if (!canCreateForecastCapability() || !canEditPage('forecast')) {
        alert('您沒有 Forecast 編輯權限。');
        return;
    }

    try {
        const cached = myQuotesCache.find(q => q.quoteNo === quoteNo);
        const quoteSnapshot = cached ? null : await firestoreReadWithTimeout(
            db.collection('quotes').doc(quoteNo).get(),
            '建立 Forecast 的估價單'
        );
        const q = cached || quoteSnapshot?.data();

        if (!q) {
            throw new Error('找不到估價單');
        }

        const existing = await firestoreReadWithTimeout(
            db.collection('forecasts')
                .where('sourceType', '==', DOCUMENT_TYPES.QUOTE)
                .where('sourceId', '==', quoteNo)
                .limit(1)
                .get(),
            'Forecast 重複來源檢查'
        );

        if (!existing.empty) {
            alert('這張估價單已建立 Forecast。');
            return;
        }

        const now = forecastNowIso();
        const items = q.items || [];

        const productName = items
            .map(item => item.nameCn || item.nameEn || item.model)
            .filter(Boolean)
            .join('、');

        const brands = dedupeBrandsCaseInsensitive(
            items.map(item => resolveBrandName(item.brand)).filter(Boolean)
        );

        const brand = brands.length === 1 ? brands[0] : brands.join(' / ');
        const brandIds = [...new Set(items.map(item => item.brandId || brandIdForName(item.brand || '')).filter(Boolean))];
        const brandId = brandIds.length === 1 ? brandIds[0] : '';
        const status = q.dealClosed ? 'won' : 'active';
        const stage = q.dealClosed ? 'stage5' : 'stage2';
        const displayProgress = `${forecastTodayLabel()} 由估價單建立`;

        const ref = db.collection('forecasts').doc();

        const forecastCustomerName = q.ordererName || q.clientName || '';
        const record = {
            customerName: forecastCustomerName,
            customerId: q.customerId || syncCustomerMaster(forecastCustomerName, { salesCode: q.salesCode || salesCodeForName(q.salesName) }),
            brand,
            brandId,
            brandIds,
            productName,
            // Forecast 主列表維持一筆，但保留估價單每個品項的 snapshot，轉訂單時才能拆回多筆。
            items: items.map(item => ({
                nameCn: item.nameCn || '',
                nameEn: item.nameEn || '',
                model: item.model || '',
                brand: resolveBrandName(item.brand || ''),
                brandId: item.brandId || brandIdForName(item.brand || ''),
                productId: item.productId || '',
                productLine: item.productLine || '',
                productType: item.productType || '',
                spec: item.spec || '',
                qty: Number(item.qty || 1),
                price: parseMoney(item.price),
                subtotal: parseMoney(item.subtotal)
            })),
            estimatedAmount: Number(String(q.grandTotal || '').replace(/,/g, '')) || 0,
            company: q.company || '',
            stage,
            status,
            closedAt: status === 'active' ? null : now,
            latestProgress: displayProgress,
            latestProgressAt: now,
            salesName: q.salesName || currentUserName || '',
            salesCode: q.salesCode || salesCodeForName(q.salesName) || currentUserCode || '',
            ownerUid: q.ownerUid || currentUser?.uid || '',
            createdAt: now,
            ...commercialCreatorFields(),
            updatedAt: now,
            ...linkedDocumentFields(
                DOCUMENT_TYPES.QUOTE,
                quoteNo,
                [documentLink(DOCUMENT_TYPES.QUOTE, quoteNo, 'source')]
            )
        };

        record.searchTokens = buildFullHistorySearchTokens('forecast', record);

        const batch = db.batch();

        batch.set(ref, record);

        batch.set(ref.collection('progress').doc(), {
            text: '由估價單建立',
            displayText: displayProgress,
            stage,
            status,
            createdAt: now,
            createdByUid: currentUser?.uid || '',
            createdByName: currentUserName || ''
        });

        batch.update(db.collection('quotes').doc(quoteNo), {
            linkedDocuments: normalizeDocumentLinks([
                ...(q.linkedDocuments || []),
                documentLink(DOCUMENT_TYPES.FORECAST, ref.id, 'created')
            ])
        });

        await batch.commit();

        // Firestore 已成功後立即同步本機 Forecast 快取，不再等待重新整理或重查資料庫。
        // 這和手動新增 Forecast 的做法一致，讓使用者切到 Forecast 頁面就能看到新案件。
        forecastCache = [
            { id: ref.id, ...record },
            ...forecastCache.filter(item => item.id !== ref.id)
        ].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        writeAppDataCache('forecasts', forecastCache);
        populateForecastBrandFilter();
        populateForecastSalesFilter();
        renderForecastList();

        alert('已從估價單建立 Forecast。');
    } catch (err) {
        console.error('建立 Forecast 失敗', err);
        alert('建立 Forecast 失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    }
};

window.markQuoteAsDeal = async function(quoteNo) {
    const button=actionButtonFromEventOrSelector();
    const buttonState=beginActionButton(button,'開啟訂單…');
    if(button && !buttonState)return;
    try {
        const cached=myQuotesCache.find(q=>q.quoteNo===quoteNo) || quoteHistorySearchResults.find(q=>q.quoteNo===quoteNo);
        const quoteSnapshot=cached ? null : await firestoreReadWithTimeout(
            db.collection('quotes').doc(quoteNo).get(),
            '成交轉訂單估價單'
        );
        const q=cached || quoteSnapshot?.data();
        if(!q)throw new Error('找不到這張估價單');
        if(currentUserRole==='engineer'&&!belongsToCurrentUser(q.salesName,q.ownerUid,q.salesCode))throw new Error('代建估價單請交由負責業務建立訂單。');
        if(q.dealClosed){alert('這張估價單已經標記過成交了。');return;}
        const sourceItems=(q.items||[]).filter(item=>item.nameCn||item.nameEn||item.model);
        if(!sourceItems.length)throw new Error('估價單沒有可建立訂單的品項。');
        assertOrderItemCount(sourceItems);

        // 成交不是直接寫死訂貨方式。先進入正式的訂單輸入流程，
        // 讓使用者逐品項確認「採購下單／業務自行訂購」及「倉庫／原廠直送」後才儲存。
        const toOrderItem=(sourceItem,index)=>{
            const brand=resolveBrandName(sourceItem.brand||'');
            const priceMatch=sourceItem.model?findPriceItemForOrder({itemCode:sourceItem.model,brand}):null;
            return normalizeNewOrderItem({
                itemId:`quote-${index+1}`,
                productId:sourceItem.productId||priceMatch?.productId||(priceMatch?stableProductId(priceMatch):''),
                productMasterMatched:sourceItem.productMasterMatched===true&&!!sourceItem.productId,
                itemCode:sourceItem.model||'', itemName:sourceItem.nameCn||sourceItem.nameEn||'',
                itemNameEn:sourceItem.nameEn||'', brand,
                brandId:sourceItem.brandId||priceMatch?.brandId||brandIdForName(brand),
                productLine:sourceItem.productLine||priceMatch?.productLine||'',
                productType:sourceItem.productType||priceMatch?.productType||'',
                spec:sourceItem.spec||priceMatch?.spec||'', supplier:priceMatch?.supplier||'',
                qty:Number(sourceItem.qty||1), unitPrice:parseMoney(sourceItem.price||0),
                procurementType:'PURCHASING_PO', fulfillmentType:'WAREHOUSE'
            });
        };
        const items=sourceItems.map(toOrderItem);
        const first=items[0];
        openOrderWorkspace(document.querySelector('[data-main-nav="orders"]'));
        openOrderModal({
            ...first,
            customerName:q.ordererName||q.clientName||'',
            sourceType:DOCUMENT_TYPES.QUOTE,
            sourceId:quoteNo,
            ownerUid:q.ownerUid||'',
            salesName:stripPhoneSuffix(q.salesName||''),
            salesCode:q.salesCode||salesCodeForName(q.salesName)
        });
        newOrderDraftItems=items.slice(1);
        renderNewOrderDraftItems();
        window._orderModalQuoteContext={
            quoteNo,
            ownerUid:q.ownerUid||'',
            salesName:stripPhoneSuffix(q.salesName||''),
            salesCode:q.salesCode||salesCodeForName(q.salesName),
            company:q.company||'',
            invoiceTitle:q.clientName||''
        };
        const title=document.getElementById('orderModalTitle');
        if(title)title.innerText=`估價單 ${quoteNo} 成交 → 建立訂單`;
        const invoice=document.getElementById('orderInvoiceTitle');
        if(invoice)invoice.value=q.clientName||'';
        window.scrollTo({top:0,behavior:'smooth'});
    } catch(err) {
        alert('開啟訂單失敗：'+err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    } finally {
        endActionButton(button,buttonState);
    }
};

window.unmarkQuoteAsDeal = async function(quoteNo) {
    if (!canManageOrderLifecycleCapability() || !canEditPage('quote.my')) return;
    const button=actionButtonFromEventOrSelector();
    const buttonState=beginActionButton(button,'處理中…');
    if(button && !buttonState)return;
    if (!confirm(
        `確定要取消估價單 ${quoteNo} 的成交狀態嗎？相關訂單將標記為取消並釋放已預留庫存，不會永久刪除。`
    )) { endActionButton(button,buttonState); return; }

    try {
        const linkedOrders = await readQueryInBatches(
            db.collection('orders').where('quoteNo', '==', quoteNo).orderBy('quoteNo')
        );

        const actor = deliveryActor();
        const cancelledAt = new Date().toISOString();
        const cancelledDate = localDateString();

        // 每筆來源訂單沿用正式的訂單生命週期與庫存釋放邏輯
        for (const linkedOrder of linkedOrders) {
            await runRoleTransaction(async transaction => {
                const orderRef = db.collection('orders').doc(linkedOrder.id);
                const orderSnap = await transaction.get(orderRef);

                if (!orderSnap.exists) return;

                const order = orderSnap.data();

                // 已取消的訂單不重複釋放庫存
                if (normalizedOrderStatus(order) === 'cancelled') return;

                await adjustInventoryReservationForLifecycle(
                    transaction,
                    linkedOrder.id,
                    order,
                    'cancelled',
                    actor
                );

                const history = {
                    action: 'status_change',
                    before: {
                        status: normalizedOrderStatus(order),
                        date: order.orderStatusDate || '',
                        reason: order.orderStatusReason || ''
                    },
                    after: {
                        status: 'cancelled',
                        date: cancelledDate,
                        reason: '來源估價單取消成交'
                    },
                    by: actor,
                    at: cancelledAt
                };

                const cancelledOrder = {...order,status:'cancelled',orderStatus:'cancelled',orderStatusDate:cancelledDate,orderStatusReason:'來源估價單取消成交'};
                transaction.update(orderRef, {
                    status: 'cancelled',
                    orderStatus: 'cancelled',
                    orderStatusDate: cancelledDate,
                    orderStatusReason: '來源估價單取消成交',
                    cancelledAt,
                    cancelledBy: actor,
                    cancelReason: '來源估價單取消成交',
                    ...orderWorkIndexFields(cancelledOrder),
                    orderLifecycleHistory:
                        firebase.firestore.FieldValue.arrayUnion(history),
                    linkedDocuments:
                        normalizeDocumentLinks(order.linkedDocuments || [])
                });
            });
        }

        // 所有來源訂單處理完成後，才解除估價單成交狀態
        await db.collection('quotes').doc(quoteNo).update({
            dealClosed: false,
            dealClosedAt: null,
            status: BUSINESS_STATUS.ACTIVE
        });

        const reopenPatch={dealClosed:false,dealClosedAt:null,status:BUSINESS_STATUS.ACTIVE};
        const cachedQuote=myQuotesCache.find(item=>item.quoteNo===quoteNo);
        if(cachedQuote)Object.assign(cachedQuote,reopenPatch);
        const searchedQuote=quoteHistorySearchResults.find(item=>item.quoteNo===quoteNo);
        if(searchedQuote)Object.assign(searchedQuote,reopenPatch);
        renderMyQuotesList();

        alert('成交狀態已取消；相關訂單已保留並標記為取消，預留庫存已同步釋放。');

    } catch (err) {
        alert('取消失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    } finally {
        endActionButton(button,buttonState);
    }
};
