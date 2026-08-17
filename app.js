// app.js - 估價單系統 / 儀器管理系統 / 管理員雲端後台 核心邏輯

const firebaseConfig = {
    apiKey: "AIzaSyAmGAU2spWI54ujLyIFTWiX-mXyuau7Vps",
    authDomain: "yu-shing-company.firebaseapp.com",
    projectId: "yu-shing-company",
    storageBucket: "yu-shing-company.firebasestorage.app",
    messagingSenderId: "22622213823",
    appId: "1:22622213823:web:c3f0a9c367a88e271ed80a",
    measurementId: "G-861X26VW6M"
};

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();

let currentCompany = 'yushin';
let salesList = [
    { name: "預設業務", code: "01", phone: "0912345678" }
];
let priceList = [];
let activeBrandFilter = 'ALL';
let currentUser = null;
let pendingTab = null;

// 儀器管理系統狀態
let equipmentList = [];
let currentEquipmentId = null;

// 管理員後台狀態
let allQuotesCache = [];

const companyData = {
    yushin: {
        title: "又鑫生物科技有限公司",
        sub: "YU SHING BIO-TECH CO., LTD.",
        addr: "地址：臺北市中山區民生東路1段58號9樓之1",
        contact: "Tel: (02)2100-1008 &nbsp;|&nbsp; Fax: (02)2522-1018 &nbsp;|&nbsp; 統編: 12698994",
        prefix: "YS",
        stamp: "stamp_yushin.png"
    },
    morningstar: {
        title: "辰星生物科技有限公司",
        sub: "MORNINGSTAR BIO-TECH CO., LTD.",
        addr: "地址：臺北市中正區重慶南路3段21號9樓",
        contact: "統編: 83468656",
        prefix: "MS",
        stamp: "stamp_morningstar.png"
    },
    "MULTI-LIFE": {
        title: "鼎新生物科技有限公司",
        sub: "MULTI-LIFE BIOTECHNOLOGY LTD.",
        addr: "地址：臺北市中山區南京東路1段34號7樓",
        contact: "Tel: (02)2568-2059 &nbsp;|&nbsp; Fax: (02)2521-7595 &nbsp;|&nbsp; 統編: 25127434",
        prefix: "DS",
        stamp: "stamp_MULTI-LIFE.png"
    }
};

window.addEventListener('DOMContentLoaded', () => {
    const printBtn = document.getElementById('printBtn');
    if (printBtn) {
        printBtn.addEventListener('click', handleSaveAndPrint);
    }

    initDate();
    initSalesList();
    loadPriceListFromCloud();
    loadClientHistory();

    const savedValidDays = localStorage.getItem('quote_valid_days');
    if (savedValidDays) {
        document.getElementById('validDays').value = savedValidDays;
    }

    addQuoteRow();
    switchCompany('yushin');
    const statusEl = document.getElementById('authStatus');
    if (statusEl) {
        statusEl.innerText = '測試模式：不需登入';
    }
});

/* =========================================================
   主分頁切換
   ========================================================= */
window.switchMainTab = function(tabId, el) {
    actuallySwitchMainTab(tabId, el);
};

function actuallySwitchMainTab(tabId, el) {
    document.querySelectorAll('.content-section').forEach(el2 => el2.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(el2 => el2.classList.remove('active'));

    document.getElementById(tabId).classList.add('active');
    if (el) {
        el.classList.add('active');
    } else {
        const idx = { 'quote-system': 0, 'equipment-system': 1, 'admin-system': 2 }[tabId];
        const tabs = document.querySelectorAll('.nav-tab');
        if (tabs[idx]) tabs[idx].classList.add('active');
    }

    if (tabId === 'equipment-system') {
        populateEquipmentSalesDropdown();
        loadEquipmentFromCloud();
    } else if (tabId === 'admin-system') {
        renderAdminSalesTable();
        renderAdminPricesTable();
        loadAllQuotesFromCloud();
    }
}

/* =========================================================
   估價單系統
   ========================================================= */
function initSalesList() {
    db.collection('settings').doc('sales').get().then(doc => {
        if (doc.exists && doc.data().list && doc.data().list.length > 0) {
            salesList = doc.data().list;
            populateSalesDropdown();
            populateEquipmentSalesDropdown();
        } else {
            loadSalesCSVFile();
        }
    }).catch(() => {
        loadSalesCSVFile();
    });
}

function loadSalesCSVFile() {
    Papa.parse('sales.csv', {
        download: true,
        header: true,
        skipEmptyLines: true,
        complete: function(results) {
            if (results.data && results.data.length > 0) {
                salesList = results.data
                    .filter(s => s.name && s.code)
                    .map(s => ({ name: (s.name || '').trim(), code: (s.code || '').trim(), phone: (s.phone || '').trim() }));
            }
            populateSalesDropdown();
            populateEquipmentSalesDropdown();
        },
        error: function() {
            populateSalesDropdown();
            populateEquipmentSalesDropdown();
        }
    });
}

window.switchCompany = function(compKey, el) {
    currentCompany = compKey;
    document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));

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
    const info = companyData[currentCompany];
    const dateStr = getFormattedDateCode();

    const salesSelect = document.getElementById('salesName');
    let salesCode = "01";

    if (salesSelect && salesSelect.selectedOptions.length > 0) {
        salesCode = salesSelect.selectedOptions[0].getAttribute('data-code') || "01";
    }

    const prefix = `${info.prefix}-${dateStr}-${salesCode}-`;

    try {
        const snapshot = await db.collection('quotes')
            .where('quoteNo', '>=', prefix)
            .where('quoteNo', '<=', prefix + '\uf8ff')
            .get();

        const count = snapshot.size + 1;
        document.getElementById('quoteNo').value = `${prefix}${String(count).padStart(2, '0')}`;
    } catch (e) {
        document.getElementById('quoteNo').value = `${prefix}01`;
    }
};

window.onSalesChange = function() {
    generateQuoteNo();
    const lastSales = document.getElementById('salesName').value;
    localStorage.setItem('last_sales_name', lastSales);
};

function populateSalesDropdown() {
    const select = document.getElementById('salesName');
    if (!select) return;

    select.innerHTML = '';
    const lastSales = localStorage.getItem('last_sales_name');

    salesList.forEach(s => {
        if (s.name && s.code) {
            const displayName = `${s.name} (${s.code})`;
            const option = document.createElement('option');
            option.value = `${s.name} ${s.phone || ''}`;
            option.text = displayName;
            option.setAttribute('data-code', s.code);
            select.appendChild(option);
        }
    });

    if (lastSales) {
        select.value = lastSales;
    }
    generateQuoteNo();
}

function populateEquipmentSalesDropdown() {
    const select = document.getElementById('eqSales');
    if (!select) return;

    select.innerHTML = '<option value="">未指定業務</option>';
    salesList.forEach(s => {
        if (s.name) {
            const option = document.createElement('option');
            option.value = s.name;
            option.text = s.name;
            select.appendChild(option);
        }
    });
}

function loadPriceListFromCloud() {
    db.collection('settings').doc('prices').get().then(doc => {
        if (doc.exists) {
            priceList = doc.data().list || [];
            refreshPriceDatalists();
        }
    }).catch(() => {});
}

function refreshPriceDatalists() {
    const cnList = document.getElementById('priceNameCnList');
    const enList = document.getElementById('priceNameEnList');
    const modelList = document.getElementById('priceModelList');
    if (!cnList || !enList) return;
    cnList.innerHTML = '';
    enList.innerHTML = '';
    if (modelList) modelList.innerHTML = '';
    priceList.forEach(p => {
        if (p.nameCn) {
            const opt = document.createElement('option');
            opt.value = p.nameCn;
            cnList.appendChild(opt);
        }
        if (p.nameEn) {
            const opt = document.createElement('option');
            opt.value = p.nameEn;
            enList.appendChild(opt);
        }
        if (p.model && modelList) {
            const opt = document.createElement('option');
            opt.value = p.model;
            modelList.appendChild(opt);
        }
    });
}

function loadClientHistory() {
    db.collection('quotes').get().then(snapshot => {
        const clientListDatalist = document.getElementById('clientList');
        if (!clientListDatalist) return;

        const clients = new Set();
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.clientName) clients.add(data.clientName);
        });

        clientListDatalist.innerHTML = '';
        clients.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c;
            clientListDatalist.appendChild(opt);
        });
    }).catch(() => {});
}

window.saveToStorage = function() {
    const validDays = document.getElementById('validDays').value;
    localStorage.setItem('quote_valid_days', validDays);
};

window.addQuoteRow = function(itemData = {}) {
    const tbody = document.getElementById('quoteItems');
    const rowCount = tbody.rows.length + 1;
    const tr = document.createElement('tr');

    tr.innerHTML = `
        <td>${rowCount}</td>
        <td>
            <div class="item-input-group">
                <div class="field-row">
                    <label>英文品名：</label>
                    <input type="text" class="item-en" list="priceNameEnList" value="${itemData.nameEn || ''}">
                </div>
                <div class="field-row">
                    <label>中文品名：</label>
                    <input type="text" class="item-cn" list="priceNameCnList" value="${itemData.nameCn || ''}" onchange="onItemCnChange(this)">
                </div>

                <div class="item-row-pair">
                    <div>
                        <label>貨號：</label>
                        <input type="text" class="item-model" list="priceModelList" value="${itemData.model || ''}" onchange="onItemModelChange(this)">
                    </div>
                    <div>
                        <label>廠牌：</label>
                        <input type="text" class="item-brand" value="${itemData.brand || ''}">
                    </div>
                </div>

                <div class="field-row">
                    <label>規格：</label>
                    <textarea class="item-spec">${itemData.spec || ''}</textarea>
                </div>
            </div>
        </td>
        <td><input type="number" class="qty" value="${itemData.qty || 1}" min="1" oninput="calculateTotals()"></td>
        <td><input type="number" class="inc-price" value="${itemData.price || 0}" oninput="onIncPriceChange(this)"></td>
        <td><input type="number" class="ex-price" value="${itemData.exPrice || ((itemData.price || 0) / 1.05).toFixed(2)}" oninput="onExPriceChange(this)"></td>
        <td><input type="number" class="subtotal-inc" value="${itemData.subtotal || 0}" readonly style="background-color: #f9f9f9;"></td>
        <td class="no-print"><button type="button" class="btn-danger" onclick="removeQuoteRow(this)">刪除</button></td>
    `;

    tbody.appendChild(tr);
    calculateTotals();
};

window.onItemCnChange = function(input) {
    const match = priceList.find(p => p.nameCn === input.value);
    if (!match) return;
    const row = input.closest('tr');
    row.querySelector('.item-en').value = match.nameEn || '';
    row.querySelector('.item-model').value = match.model || '';
    row.querySelector('.item-brand').value = match.brand || '';
    if (match.price) {
        row.querySelector('.inc-price').value = match.price;
        onIncPriceChange(row.querySelector('.inc-price'));
    }
};

window.onItemModelChange = function(input) {
    const value = input.value.trim();
    if (!value) return;
    const match = priceList.find(p => p.model && p.model.trim() === value);
    if (!match) return;
    const row = input.closest('tr');
    row.querySelector('.item-en').value = match.nameEn || '';
    row.querySelector('.item-cn').value = match.nameCn || '';
    row.querySelector('.item-brand').value = match.brand || '';
    if (match.price) {
        row.querySelector('.inc-price').value = match.price;
        onIncPriceChange(row.querySelector('.inc-price'));
    }
};

window.onIncPriceChange = function(input) {
    const row = input.closest('tr');
    const incPrice = parseFloat(input.value) || 0;
    const exPriceInput = row.querySelector('.ex-price');

    exPriceInput.value = (incPrice / 1.05).toFixed(2);
    calculateTotals();
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
};

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

window.handleSaveAndPrint = function() {
    const quoteNo = document.getElementById('quoteNo').value.trim();
    const clientName = document.getElementById('clientName').value;

    if (!quoteNo) {
        alert('請填寫估價單號！');
        return;
    }

    document.title = quoteNo;

    const quoteData = {
        quoteNo: quoteNo,
        company: currentCompany,
        clientName: clientName,
        salesName: document.getElementById('salesName').value,
        quoteDate: document.getElementById('quoteDate').value,
        validDays: document.getElementById('validDays').value,
        discountRate: document.getElementById('discountRateInput').value,
        grandTotal: document.getElementById('grandTotal').innerText,
        items: []
    };

    document.querySelectorAll('#quoteItems tr').forEach(row => {
        quoteData.items.push({
            nameEn: row.querySelector('.item-en').value,
            nameCn: row.querySelector('.item-cn').value,
            model: row.querySelector('.item-model').value,
            brand: row.querySelector('.item-brand').value,
            spec: row.querySelector('.item-spec').value,
            qty: row.querySelector('.qty').value,
            price: row.querySelector('.inc-price').value,
            exPrice: row.querySelector('.ex-price').value,
            subtotal: row.querySelector('.subtotal-inc').value
        });
    });

    db.collection('quotes').doc(quoteNo).set(quoteData)
        .then(() => { window.print(); })
        .catch(() => { window.print(); });
};

window.loadQuoteFromCloud = function() {
    const qNo = document.getElementById('searchQuoteNo').value.trim();
    if (!qNo) {
        alert('請輸入要查詢的估價單號');
        return;
    }
    fetchAndFillQuote(qNo);
};

function fetchAndFillQuote(qNo) {
    db.collection('quotes').doc(qNo).get().then(doc => {
        if (doc.exists) {
            const data = doc.data();
            actuallySwitchMainTab('quote-system');
            document.getElementById('quoteNo').value = data.quoteNo;
            document.getElementById('clientName').value = data.clientName;
            document.getElementById('salesName').value = data.salesName;
            document.getElementById('quoteDate').value = data.quoteDate;
            document.getElementById('validDays').value = data.validDays;
            document.getElementById('discountRateInput').value = data.discountRate || 0;
            if (data.company) {
                switchCompany(data.company);
            }

            document.getElementById('quoteItems').innerHTML = '';
            data.items.forEach(item => addQuoteRow(item));
        } else {
            alert('找不到該估價單');
        }
    }).catch(() => {
        alert('無法從雲端讀取');
    });
}

/* =========================================================
   儀器管理系統：客戶儀器維修保養／校正紀錄
   ========================================================= */
window.loadEquipmentFromCloud = function() {
    db.collection('equipment').orderBy('customerName').get().then(snapshot => {
        equipmentList = [];
        snapshot.forEach(doc => {
            equipmentList.push({ id: doc.id, ...doc.data() });
        });
        renderEquipmentList();
    }).catch(err => {
        console.error(err);
        alert('讀取儀器資料失敗，請確認 Firestore 權限設定。');
    });
};

function addMonths(dateStr, months) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    d.setMonth(d.getMonth() + months);
    return d;
}

function getEquipmentStatus(eq) {
    const baseDate = eq.lastServiceDate || eq.installDate;
    const cycle = parseInt(eq.cycleMonths) || 12;
    const due = addMonths(baseDate, cycle);
    if (!due) return { status: 'unknown', dueDate: null };

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((due - today) / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return { status: 'overdue', dueDate: due, diffDays };
    if (diffDays <= 30) return { status: 'soon', dueDate: due, diffDays };
    return { status: 'ok', dueDate: due, diffDays };
}

function fmtDate(d) {
    if (!d) return '－';
    if (typeof d === 'string') return d;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}/${mm}/${dd}`;
}

const statusLabel = { ok: '正常', soon: '即將到期', overdue: '已逾期', unknown: '尚無紀錄' };
const statusClass = { ok: 'status-ok', soon: 'status-soon', overdue: 'status-overdue', unknown: 'status-unknown' };

window.renderEquipmentList = function() {
    const tbody = document.getElementById('eqListBody');
    const keyword = (document.getElementById('eqSearchInput').value || '').toLowerCase();
    const statusFilter = document.getElementById('eqStatusFilter').value;

    tbody.innerHTML = '';
    let shown = 0;

    equipmentList.forEach(eq => {
        const searchable = `${eq.customerName || ''} ${eq.brand || ''} ${eq.salesName || ''} ${eq.name || ''} ${eq.serialNo || ''}`.toLowerCase();
        if (keyword && !searchable.includes(keyword)) return;

        const { status, dueDate } = getEquipmentStatus(eq);
        if (statusFilter !== 'all' && status !== statusFilter) return;

        shown++;
        const tr = document.createElement('tr');
        tr.className = 'clickable-row';
        tr.onclick = () => openEquipmentDetail(eq.id);
        tr.innerHTML = `
            <td>${escapeHtml(eq.customerName || '')}</td>
            <td>${escapeHtml(eq.brand || '－')}</td>
            <td>${escapeHtml(eq.name || '')}</td>
            <td>${escapeHtml(eq.model || '')} / ${escapeHtml(eq.serialNo || '')}</td>
            <td>${escapeHtml(eq.salesName || '未指定')}</td>
            <td>${escapeHtml(eq.location || '')}</td>
            <td>${fmtDate(eq.lastServiceDate)}</td>
            <td>${fmtDate(dueDate)}</td>
            <td><span class="status-badge ${statusClass[status]}">${statusLabel[status]}</span></td>
            <td class="no-print"><button type="button" class="btn-danger" onclick="event.stopPropagation(); deleteEquipment('${eq.id}')">刪除</button></td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById('eqEmptyHint').style.display = shown === 0 ? 'block' : 'none';
};

function escapeHtml(str) {
    const div = document.createElement('div');
    div.innerText = str;
    return div.innerHTML;
}

window.openEquipmentForm = function(eqId) {
    closeEquipmentDetail();
    populateEquipmentSalesDropdown();

    const panel = document.getElementById('eqFormPanel');
    panel.style.display = 'block';
    panel.dataset.editId = eqId || '';

    if (eqId) {
        const eq = equipmentList.find(e => e.id === eqId);
        document.getElementById('eqFormTitle').innerText = '編輯儀器';
        document.getElementById('eqCustomer').value = eq.customerName || '';
        document.getElementById('eqBrand').value = eq.brand || '';
        document.getElementById('eqName').value = eq.name || '';
        document.getElementById('eqModel').value = eq.model || '';
        document.getElementById('eqSerial').value = eq.serialNo || '';
        document.getElementById('eqSales').value = eq.salesName || '';
        document.getElementById('eqLocation').value = eq.location || '';
        document.getElementById('eqInstallDate').value = eq.installDate || '';
        document.getElementById('eqCycle').value = eq.cycleMonths || 12;
        document.getElementById('eqLastService').value = eq.lastServiceDate || '';
        document.getElementById('eqNotes').value = eq.notes || '';
    } else {
        document.getElementById('eqFormTitle').innerText = '新增儀器';
        ['eqCustomer', 'eqBrand', 'eqName', 'eqModel', 'eqSerial', 'eqSales', 'eqLocation', 'eqInstallDate', 'eqLastService', 'eqNotes'].forEach(id => {
            document.getElementById(id).value = '';
        });
        document.getElementById('eqCycle').value = 12;
    }
    panel.scrollIntoView({ behavior: 'smooth' });
};

window.closeEquipmentForm = function() {
    document.getElementById('eqFormPanel').style.display = 'none';
};

window.saveEquipment = function() {
    const editId = document.getElementById('eqFormPanel').dataset.editId;
    const data = {
        customerName: document.getElementById('eqCustomer').value.trim(),
        brand: document.getElementById('eqBrand').value.trim(),
        name: document.getElementById('eqName').value.trim(),
        model: document.getElementById('eqModel').value.trim(),
        serialNo: document.getElementById('eqSerial').value.trim(),
        salesName: document.getElementById('eqSales').value.trim(),
        location: document.getElementById('eqLocation').value.trim(),
        installDate: document.getElementById('eqInstallDate').value,
        cycleMonths: parseInt(document.getElementById('eqCycle').value) || 12,
        lastServiceDate: document.getElementById('eqLastService').value,
        notes: document.getElementById('eqNotes').value.trim()
    };

    if (!data.customerName || !data.name) {
        alert('請至少填寫客戶名稱與儀器名稱');
        return;
    }

    const ref = editId ? db.collection('equipment').doc(editId) : db.collection('equipment').doc();
    const payload = editId ? data : { ...data, logs: [] };

    ref.set(payload, { merge: true }).then(() => {
        closeEquipmentForm();
        loadEquipmentFromCloud();
    }).catch(err => {
        alert('儲存失敗：' + err.message);
    });
};

window.deleteEquipment = function(eqId) {
    if (!confirm('確定要刪除這台儀器的所有紀錄嗎？此動作無法復原。')) return;
    db.collection('equipment').doc(eqId).delete().then(() => {
        loadEquipmentFromCloud();
        closeEquipmentDetail();
    }).catch(err => {
        alert('刪除失敗：' + err.message);
    });
};

window.openEquipmentDetail = function(eqId) {
    closeEquipmentForm();
    currentEquipmentId = eqId;
    const eq = equipmentList.find(e => e.id === eqId);
    if (!eq) return;

    const { status, dueDate } = getEquipmentStatus(eq);
    document.getElementById('eqDetailTitle').innerText = `${eq.customerName} － ${eq.name}`;
    document.getElementById('eqDetailInfo').innerHTML = `
        廠牌：${escapeHtml(eq.brand || '－')} 型號：${escapeHtml(eq.model || '－')} 序號：${escapeHtml(eq.serialNo || '－')} 負責業務：${escapeHtml(eq.salesName || '未指定')}<br>
        放置地點：${escapeHtml(eq.location || '－')} 安裝日期：${fmtDate(eq.installDate) || '－'} 保養週期：每 ${eq.cycleMonths || 12} 個月<br>
        下次到期：${fmtDate(dueDate)} <span class="status-badge ${statusClass[status]}">${statusLabel[status]}</span><br>
        備註：${escapeHtml(eq.notes || '無')}
        <div style="margin-top:8px;"><button type="button" class="btn-small" onclick="openEquipmentForm('${eq.id}')">✏️ 編輯基本資料</button></div>
    `;

    const logBody = document.getElementById('eqLogBody');
    logBody.innerHTML = '';
    const logs = (eq.logs || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (logs.length === 0) {
        logBody.innerHTML = '<tr><td colspan="5" style="color:#888;">尚無紀錄</td></tr>';
    } else {
        logs.forEach((log) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${fmtDate(log.date)}</td>
                <td>${escapeHtml(log.type || '')}</td>
                <td>${escapeHtml(log.tech || '')}</td>
                <td style="text-align:left;">${escapeHtml(log.desc || '')}</td>
                <td class="no-print"><button type="button" class="btn-danger" onclick="deleteEquipmentLog('${eq.id}', ${equipmentLogRealIndex(eq, log)})">刪除</button></td>
            `;
            logBody.appendChild(tr);
        });
    }

    document.getElementById('eqLogDate').value = '';
    document.getElementById('eqLogTech').value = '';
    document.getElementById('eqLogDesc').value = '';

    document.getElementById('eqDetailPanel').style.display = 'block';
    document.getElementById('eqDetailPanel').scrollIntoView({ behavior: 'smooth' });
};

function equipmentLogRealIndex(eq, log) {
    return (eq.logs || []).indexOf(log);
}

window.closeEquipmentDetail = function() {
    document.getElementById('eqDetailPanel').style.display = 'none';
    currentEquipmentId = null;
};

window.addEquipmentLog = function() {
    if (!currentEquipmentId) return;
    const date = document.getElementById('eqLogDate').value;
    const type = document.getElementById('eqLogType').value;
    const tech = document.getElementById('eqLogTech').value.trim();
    const desc = document.getElementById('eqLogDesc').value.trim();

    if (!date) {
        alert('請選擇日期');
        return;
    }

    const eq = equipmentList.find(e => e.id === currentEquipmentId);
    const newLog = { date, type, tech, desc };
    const updatedLogs = [...(eq.logs || []), newLog];

    const updates = { logs: updatedLogs };
    if ((type === '保養' || type === '校正') && (!eq.lastServiceDate || date >= eq.lastServiceDate)) {
        updates.lastServiceDate = date;
    }

    db.collection('equipment').doc(currentEquipmentId).update(updates).then(() => {
        loadEquipmentFromCloudThenReopen(currentEquipmentId);
    }).catch(err => {
        alert('新增紀錄失敗：' + err.message);
    });
};

window.deleteEquipmentLog = function(eqId, logIndex) {
    if (!confirm('確定要刪除這筆紀錄嗎？')) return;
    const eq = equipmentList.find(e => e.id === eqId);
    if (!eq) return;
    const updatedLogs = (eq.logs || []).filter((_, idx) => idx !== logIndex);
    db.collection('equipment').doc(eqId).update({ logs: updatedLogs }).then(() => {
        loadEquipmentFromCloudThenReopen(eqId);
    }).catch(err => {
        alert('刪除失敗：' + err.message);
    });
};

function loadEquipmentFromCloudThenReopen(eqId) {
    db.collection('equipment').orderBy('customerName').get().then(snapshot => {
        equipmentList = [];
        snapshot.forEach(doc => equipmentList.push({ id: doc.id, ...doc.data() }));
        renderEquipmentList();
        openEquipmentDetail(eqId);
    });
}

// 儀器管理系統：批量上傳 Excel (包含廠牌與負責業務)
window.handleEquipmentExcelUpload = function(input) {
    const file = input.files && input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[firstSheetName];
            const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

            if (!rows.length) {
                alert('Excel 檔案中沒有讀取到任何資料。');
                input.value = '';
                return;
            }

            const getField = (row, keys) => {
                for (const k of keys) {
                    if (row[k] !== undefined && row[k] !== '') return row[k];
                }
                return '';
            };

            const batch = db.batch();
            let count = 0;

            rows.forEach(row => {
                const customerName = String(getField(row, ['客戶名稱', '客戶'])).trim();
                const name = String(getField(row, ['儀器名稱', '儀器'])).trim();
                if (!customerName || !name) return;

                const docRef = db.collection('equipment').doc();
                batch.set(docRef, {
                    customerName: customerName,
                    brand: String(getField(row, ['廠牌', '品牌'])).trim(),
                    name: name,
                    model: String(getField(row, ['型號'])).trim(),
                    serialNo: String(getField(row, ['序號'])).trim(),
                    salesName: String(getField(row, ['負責業務', '業務'])).trim(),
                    location: String(getField(row, ['放置地點', '地點'])).trim(),
                    installDate: String(getField(row, ['安裝日期'])).trim(),
                    cycleMonths: parseInt(getField(row, ['保養週期', '週期'])) || 12,
                    lastServiceDate: String(getField(row, ['最近保養日期', '最近保養'])).trim(),
                    notes: String(getField(row, ['備註'])).trim(),
                    logs: []
                });
                count++;
            });

            if (count === 0) {
                alert('無法辨識出有效儀器資料，請確保表頭有「客戶名稱」與「儀器名稱」。');
                input.value = '';
                return;
            }

            batch.commit().then(() => {
                alert(`成功批量匯入 ${count} 筆儀器資料！`);
                loadEquipmentFromCloud();
            }).catch(err => {
                alert('批量寫入 Firestore 失敗：' + err.message);
            });

        } catch (err) {
            alert('讀取 Excel 檔案失敗：' + err.message);
        } finally {
            input.value = '';
        }
    };
    reader.readAsArrayBuffer(file);
};

/* =========================================================
   管理員雲端後台
   ========================================================= */
window.switchAdminTab = function(tab, el) {
    document.querySelectorAll('#admin-system .sub-tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    document.querySelectorAll('.admin-panel').forEach(p => p.style.display = 'none');
    document.getElementById(`admin-${tab}`).style.display = 'block';

    if (tab === 'sales') renderAdminSalesTable();
    if (tab === 'prices') renderAdminPricesTable();
    if (tab === 'quotes') renderAdminQuotesList();
};

/* ---------- 業務名單管理 ---------- */
window.renderAdminSalesTable = function() {
    const tbody = document.getElementById('adminSalesBody');
    tbody.innerHTML = '';
    salesList.forEach((s, idx) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><input type="text" value="${escapeAttr(s.code)}" oninput="updateSalesField(${idx}, 'code', this.value)"></td>
            <td><input type="text" value="${escapeAttr(s.name)}" oninput="updateSalesField(${idx}, 'name', this.value)"></td>
            <td><input type="text" value="${escapeAttr(s.phone || '')}" oninput="updateSalesField(${idx}, 'phone', this.value)"></td>
            <td class="no-print"><button type="button" class="btn-danger" onclick="removeSalesRow(${idx})">刪除</button></td>
        `;
        tbody.appendChild(tr);
    });
};

function escapeAttr(str) {
    return (str || '').toString().replace(/"/g, '&quot;');
}

window.updateSalesField = function(idx, field, value) {
    salesList[idx][field] = value;
};

window.addSalesRow = function() {
    salesList.push({ code: '', name: '', phone: '' });
    renderAdminSalesTable();
};

window.removeSalesRow = function(idx) {
    salesList.splice(idx, 1);
    renderAdminSalesTable();
};

window.saveSalesToCloud = function() {
    const cleaned = salesList.filter(s => s.name && s.code);
    db.collection('settings').doc('sales').set({ list: cleaned }).then(() => {
        salesList = cleaned;
        populateSalesDropdown();
        populateEquipmentSalesDropdown();
        alert('業務名單已儲存到雲端！');
    }).catch(err => {
        alert('儲存失敗：' + err.message);
    });
};

window.reimportSalesFromCSV = function() {
    Papa.parse('sales.csv', {
        download: true,
        header: true,
        skipEmptyLines: true,
        complete: function(results) {
            salesList = results.data
                .filter(s => s.name && s.code)
                .map(s => ({ name: (s.name || '').trim(), code: (s.code || '').trim(), phone: (s.phone || '').trim() }));
            renderAdminSalesTable();
            populateEquipmentSalesDropdown();
            alert('已從 sales.csv 匯入，記得按「儲存到雲端」才會生效。');
        },
        error: function() {
            alert('讀取 sales.csv 失敗');
        }
    });
};

/* ---------- 價格表管理 ---------- */
window.renderAdminPricesTable = function() {
    renderBrandTabs();

    const tbody = document.getElementById('adminPricesBody');
    tbody.innerHTML = '';

    priceList.forEach((p, idx) => {
        if (activeBrandFilter !== 'ALL' && (p.brand || '未分類') !== activeBrandFilter) {
            return;
        }

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><input type="text" value="${escapeAttr(p.nameCn)}" oninput="updatePriceField(${idx}, 'nameCn', this.value)"></td>
            <td><input type="text" value="${escapeAttr(p.nameEn)}" oninput="updatePriceField(${idx}, 'nameEn', this.value)"></td>
            <td><input type="text" value="${escapeAttr(p.model)}" oninput="updatePriceField(${idx}, 'model', this.value)"></td>
            <td><input type="text" value="${escapeAttr(p.brand)}" oninput="updatePriceField(${idx}, 'brand', this.value)"></td>
            <td><input type="number" value="${p.price || 0}" oninput="updatePriceField(${idx}, 'price', this.value)"></td>
            <td class="no-print"><button type="button" class="btn-danger" onclick="removePriceRow(${idx})">刪除</button></td>
        `;
        tbody.appendChild(tr);
    });
};

function renderBrandTabs() {
    const tabsContainer = document.getElementById('priceBrandTabs');
    if (!tabsContainer) return;

    const brandsSet = new Set();
    priceList.forEach(p => {
        if (p.brand && p.brand.trim()) {
            brandsSet.add(p.brand.trim());
        }
    });

    const brands = Array.from(brandsSet);
    let html = `<div class="brand-tab ${activeBrandFilter === 'ALL' ? 'active' : ''}" onclick="switchBrandTab('ALL')">全部 (${priceList.length})</div>`;

    brands.forEach(b => {
        const count = priceList.filter(p => (p.brand || '').trim() === b).length;
        html += `<div class="brand-tab ${activeBrandFilter === b ? 'active' : ''}" onclick="switchBrandTab('${escapeAttr(b)}')">${escapeHtml(b)} (${count})</div>`;
    });

    tabsContainer.innerHTML = html;
}

window.switchBrandTab = function(brandName) {
    activeBrandFilter = brandName;
    renderAdminPricesTable();
};

window.updatePriceField = function(idx, field, value) {
    priceList[idx][field] = field === 'price' ? parseFloat(value) || 0 : value;
};

window.addPriceRow = function() {
    const defaultBrand = activeBrandFilter !== 'ALL' ? activeBrandFilter : '';
    priceList.push({ nameCn: '', nameEn: '', model: '', brand: defaultBrand, price: 0 });
    renderAdminPricesTable();
};

window.removePriceRow = function(idx) {
    priceList.splice(idx, 1);
    renderAdminPricesTable();
};

window.handlePriceExcelUpload = function(input) {
    const file = input.files && input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });

            const imported = [];

            const getField = (row, keys) => {
                for (const k of keys) {
                    if (row[k] !== undefined && row[k] !== '') return row[k];
                }
                return '';
            };

            workbook.SheetNames.forEach(sheetName => {
                const sheet = workbook.Sheets[sheetName];
                const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

                rows.forEach(row => {
                    const nameCn = String(getField(row, ['中文品名', '品名', '中文名稱'])).trim();
                    const nameEn = String(getField(row, ['英文品名', '英文名稱'])).trim();
                    const model = String(getField(row, ['貨號', '型號'])).trim();
                    let brand = String(getField(row, ['廠牌', '品牌'])).trim();

                    if (!brand) {
                        brand = sheetName.trim();
                    }

                    const price = parseFloat(getField(row, ['含稅單價', '單價', '價格'])) || 0;

                    if (nameCn || nameEn || model) {
                        imported.push({ nameCn, nameEn, model, brand, price });
                    }
                });
            });

            if (!imported.length) {
                alert('無法從 Excel 辨識出有效的價格資料。');
                input.value = '';
                return;
            }

            priceList = imported;
            activeBrandFilter = 'ALL';
            renderAdminPricesTable();
            alert(`已從 Excel 成功讀取 ${workbook.SheetNames.length} 個分頁，共 ${imported.length} 筆價格資料。請確認後點選「☁️ 儲存到雲端」。`);
        } catch (err) {
            alert('讀取 Excel 檔案失敗：' + err.message);
        } finally {
            input.value = '';
        }
    };
    reader.readAsArrayBuffer(file);
};

window.savePricesToCloud = function() {
    const cleaned = priceList.filter(p => p.nameCn || p.nameEn || p.model);
    db.collection('settings').doc('prices').set({ list: cleaned }).then(() => {
        priceList = cleaned;
        refreshPriceDatalists();
        renderAdminPricesTable();
        alert('價格表已儲存到雲端！');
    }).catch(err => {
        alert('儲存失敗：' + err.message);
    });
};

/* ---------- 估價單記錄管理 ---------- */
window.loadAllQuotesFromCloud = function() {
    db.collection('quotes').orderBy('quoteNo', 'desc').get().then(snapshot => {
        allQuotesCache = [];
        snapshot.forEach(doc => allQuotesCache.push({ id: doc.id, ...doc.data() }));
        renderAdminQuotesList();
    }).catch(err => {
        console.error(err);
        alert('讀取估價單記錄失敗，請確認 Firestore 權限設定。');
    });
};

window.renderAdminQuotesList = function() {
    const tbody = document.getElementById('adminQuotesBody');
    const keyword = (document.getElementById('adminQuoteSearch').value || '').toLowerCase();
    tbody.innerHTML = '';
    let shown = 0;

    allQuotesCache.forEach(q => {
        const searchable = `${q.quoteNo || ''} ${q.clientName || ''}`.toLowerCase();
        if (keyword && !searchable.includes(keyword)) return;
        shown++;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(q.quoteNo || '')}</td>
            <td>${escapeHtml((companyData[q.company] || {}).prefix || q.company || '')}</td>
            <td>${escapeHtml(q.clientName || '')}</td>
            <td>${escapeHtml(q.salesName || '')}</td>
            <td>${escapeHtml(q.quoteDate || '')}</td>
            <td>${escapeHtml(q.grandTotal || '')}</td>
            <td class="no-print">
                <button type="button" class="btn-small" onclick="openQuoteFromAdmin('${q.quoteNo}')">載入</button>
                <button type="button" class="btn-danger" onclick="deleteQuoteFromAdmin('${q.quoteNo}')">刪除</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById('adminQuotesEmptyHint').style.display = shown === 0 ? 'block' : 'none';
};

window.openQuoteFromAdmin = function(quoteNo) {
    fetchAndFillQuote(quoteNo);
};

window.deleteQuoteFromAdmin = function(quoteNo) {
    if (!confirm(`確定要刪除估價單 ${quoteNo} 嗎？此動作無法復原。`)) return;
    db.collection('quotes').doc(quoteNo).delete().then(() => {
        loadAllQuotesFromCloud();
    }).catch(err => {
        alert('刪除失敗：' + err.message);
    });
};

window.exportQuotesCSV = function() {
    const keyword = (document.getElementById('adminQuoteSearch').value || '').toLowerCase();
    const rows = allQuotesCache.filter(q => {
        const searchable = `${q.quoteNo || ''} ${q.clientName || ''}`.toLowerCase();
        return !keyword || searchable.includes(keyword);
    });

    if (rows.length === 0) {
        alert('沒有資料可以匯出');
        return;
    }

    const header = ['單號', '公司', '客戶', '業務', '日期', '總計'];
    const csvRows = [header.join(',')];
    rows.forEach(q => {
        const line = [q.quoteNo, q.company, q.clientName, q.salesName, q.quoteDate, q.grandTotal]
            .map(v => `"${(v || '').toString().replace(/"/g, '""')}"`)
            .join(',');
        csvRows.push(line);
    });

    const csvContent = '\uFEFF' + csvRows.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `估價單記錄_${getFormattedDateCode()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
};