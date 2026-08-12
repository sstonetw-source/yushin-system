// 引入 Firebase v12 ES Module SDK
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { 
    getFirestore, collection, doc, setDoc, getDoc, getDocs, query, where 
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

// Firebase 專案設定
const firebaseConfig = {
    apiKey: "AIzaSyAmGAU2spWI54ujLyIFTWiX-mXyuau7Vps",
    authDomain: "yu-shing-company.firebaseapp.com",
    projectId: "yu-shing-company",
    storageBucket: "yu-shing-company.firebasestorage.app",
    messagingSenderId: "22622213823",
    appId: "1:22622213823:web:c3f0a9c367a88e271ed80a",
    measurementId: "G-861X26VW6M"
};

// 初始化 Firebase & Firestore
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// 全局變數
let currentCompany = 'yushin';
let salesList = [];
let priceList = [];

// 三家公司抬頭與印章設定[cite: 1]
const companyConfigs = {
    yushin: {
        title: "又鑫生物科技有限公司", sub: "YU SHING BIO-TECH CO., LTD.",
        addr: "地址：10446臺北市中山區民生東路一段58號9樓-1", contact: "Tel: (02)2100-1008 | Fax: (02)2522-1018 | 統編: 12698994",
        prefix: "YS", stamp: "stamp_yushin.png"
    },
    morningstar: {
        title: "辰星生物科技有限公司", sub: "MORNINGSTAR BIO-TECH CO., LTD.",
        addr: "地址：台北市中正區重慶南路三段21號9樓", contact: "Tel: (02)2322-5429",
        prefix: "MS", stamp: "stamp_morningstar.png"
    },
    'MULTI-LIFE': {
        title: "鼎新生物科技有限公司", sub: "MULTI-LIFE BIO-TECH CO., LTD.",
        addr: "地址：台北市南京東路一段34號7樓", contact: "Tel: (02)2568-2059",
        prefix: "DS", stamp: "stamp_MULTI-LIFE.png"
    }
};

// 頁面初始化
window.addEventListener('DOMContentLoaded', async () => {
    setTodayDate();
    await loadSalesData();
    await loadPriceData();
    await generateQuoteNo();
    addQuoteRow();
    loadEquipments();
    bindEvents();
});

// 綁定按鈕事件與全局函數映射
function bindEvents() {
    window.switchMainTab = switchMainTab;
    window.switchCompany = switchCompany;
    window.onSalesChange = onSalesChange;
    window.addQuoteRow = addQuoteRow;
    window.saveQuoteToCloud = saveQuoteToCloud;
    window.loadQuoteFromCloud = loadQuoteFromCloud;
    window.saveEquipment = saveEquipment;
    window.uploadSalesCSV = uploadSalesCSV;
    window.uploadPriceCSV = uploadPriceCSV;
    window.autoFillProduct = autoFillProduct;
    window.calcTotal = calcTotal;
}

function setTodayDate() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const dateInput = document.getElementById('quoteDate');
    if (dateInput) dateInput.value = `${yyyy}/${mm}/${dd}`;
}

// 主頁籤切換
function switchMainTab(tabId) {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.content-section').forEach(c => c.classList.remove('active'));
    if (event) event.target.classList.add('active');
    const targetEl = document.getElementById(tabId);
    if (targetEl) targetEl.classList.add('active');
}

// 公司頁籤切換 (又鑫 / 辰星 / 鼎新)
function switchCompany(comp) {
    currentCompany = comp;
    document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
    if (event) event.target.classList.add('active');

    const config = companyConfigs[comp];
    document.getElementById('compTitle').innerText = config.title;
    document.getElementById('compSub').innerText = config.sub;
    document.getElementById('compAddr').innerText = config.addr;
    document.getElementById('compContact').innerText = config.contact;
    document.getElementById('companyStamp').src = config.stamp;

    generateQuoteNo();
}

// 從 Firebase 載入業務選單
async function loadSalesData() {
    try {
        const querySnapshot = await getDocs(collection(db, "sales"));
        salesList = [];
        const salesSelect = document.getElementById('salesSelect');
        const eqSalesSelect = document.getElementById('eqSalesSelect');
        if (salesSelect) salesSelect.innerHTML = '';
        if (eqSalesSelect) eqSalesSelect.innerHTML = '';

        querySnapshot.forEach((docSnap) => {
            const data = docSnap.data();
            salesList.push(data);
            const opt = `<option value="${data.code}">${data.name} (${data.code})</option>`;
            if (salesSelect) salesSelect.innerHTML += opt;
            if (eqSalesSelect) eqSalesSelect.innerHTML += opt;
        });

        if (salesList.length === 0 && salesSelect) {
            salesSelect.innerHTML = '<option value="A">預設業務 (A)</option>';
            salesList = [{ name: "預設業務", code: "A" }];
        }
    } catch (e) {
        console.error("載入業務資料失敗：", e);
    }
}

function onSalesChange() {
    generateQuoteNo();
}

// 自動生成單號：PREFIX-YYYYMMDD-業務代號-順序號(01, 02...)
async function generateQuoteNo() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}${mm}${dd}`;

    const config = companyConfigs[currentCompany];
    const salesSelect = document.getElementById('salesSelect');
    const salesCode = salesSelect ? salesSelect.value || 'A' : 'A';
    const prefix = `${config.prefix}-${dateStr}-${salesCode}-`;

    try {
        const q = query(
            collection(db, "quotations"), 
            where("quoteNo", ">=", prefix), 
            where("quoteNo", "<=", prefix + "\uf8ff")
        );
        const querySnapshot = await getDocs(q);
        const seq = String(querySnapshot.size + 1).padStart(2, '0');
        const quoteNoInput = document.getElementById('quoteNo');
        if (quoteNoInput) quoteNoInput.value = `${prefix}${seq}`;
    } catch (e) {
        console.error("計算單號失敗：", e);
    }
}

// 載入價格表
async function loadPriceData() {
    try {
        const querySnapshot = await getDocs(collection(db, "products"));
        priceList = [];
        querySnapshot.forEach((docSnap) => priceList.push(docSnap.data()));
    } catch (e) {
        console.error("載入價格表失敗：", e);
    }
}

// 新增估價單項目列
function addQuoteRow(data = {}) {
    const tbody = document.getElementById('quoteItems');
    if (!tbody) return;
    const rowCount = tbody.rows.length + 1;
    const tr = document.createElement('tr');

    tr.innerHTML = `
        <td>${rowCount}</td>
        <td>
            <input type="text" class="item-model" placeholder="輸入貨號自動帶出" value="${data.model || ''}" onchange="autoFillProduct(this)" style="width:30%;">
            <input type="text" class="item-name" placeholder="品名" value="${data.name || ''}" style="width:65%;"><br>
            <input type="text" class="item-spec" placeholder="規格/說明" value="${data.spec || ''}" style="width:96%; margin-top:2px;">
        </td>
        <td><input type="number" class="item-qty" value="${data.qty || 1}" min="1" oninput="calcTotal()" style="width:90%;"></td>
        <td><input type="number" class="item-price" value="${data.price || 0}" min="0" oninput="calcTotal()" style="width:90%;"></td>
        <td><span class="item-subtotal">${(data.qty || 1) * (data.price || 0)}</span></td>
        <td class="no-print"><button onclick="this.closest('tr').remove(); calcTotal();" style="background:#cc0000; padding:2px 5px; color:white; border:none; border-radius:3px;">刪</button></td>
    `;
    tbody.appendChild(tr);
    calcTotal();
}

// 輸入貨號自動帶出資訊
function autoFillProduct(input) {
    const model = input.value.trim();
    const prod = priceList.find(p => p.model === model);
    if (prod) {
        const tr = input.closest('tr');
        tr.querySelector('.item-name').value = `${prod.nameEn || ''} ${prod.nameCn || ''}`.trim();
        tr.querySelector('.item-spec').value = `廠牌: ${prod.brand || ''} | 規格: ${prod.spec || ''}`;
        tr.querySelector('.item-price').value = prod.price || 0;
        calcTotal();
    }
}

function calcTotal() {
    let grandTotal = 0;
    document.querySelectorAll('#quoteItems tr').forEach(tr => {
        const qty = parseFloat(tr.querySelector('.item-qty').value) || 0;
        const price = parseFloat(tr.querySelector('.item-price').value) || 0;
        const subtotal = qty * price;
        tr.querySelector('.item-subtotal').innerText = subtotal.toLocaleString();
        grandTotal += subtotal;
    });
    const grandTotalEl = document.getElementById('grandTotal');
    if (grandTotalEl) grandTotalEl.innerText = grandTotal.toLocaleString();
}

// 儲存估價單至雲端
async function saveQuoteToCloud() {
    const quoteNo = document.getElementById('quoteNo').value;
    if (!quoteNo) return alert("單號不能為空！");

    const items = [];
    document.querySelectorAll('#quoteItems tr').forEach(tr => {
        items.push({
            model: tr.querySelector('.item-model').value,
            name: tr.querySelector('.item-name').value,
            spec: tr.querySelector('.item-spec').value,
            qty: parseFloat(tr.querySelector('.item-qty').value) || 0,
            price: parseFloat(tr.querySelector('.item-price').value) || 0
        });
    });

    const quoteData = {
        company: currentCompany,
        quoteNo: quoteNo,
        clientName: document.getElementById('clientName').value,
        salesCode: document.getElementById('salesSelect').value,
        date: document.getElementById('quoteDate').value,
        grandTotal: document.getElementById('grandTotal').innerText,
        items: items,
        updatedAt: new Date().toISOString()
    };

    try {
        await setDoc(doc(db, "quotations", quoteNo), quoteData);
        alert(`估價單 [${quoteNo}] 已成功儲存至雲端！`);
    } catch (e) {
        console.error("儲存失敗：", e);
        alert("儲存失敗，請檢查網路或權限設定。");
    }
}

// 調取雲端估價單
async function loadQuoteFromCloud() {
    const searchNo = document.getElementById('searchQuoteNo').value.trim();
    if (!searchNo) return alert("請輸入完整估價單號！");

    try {
        const docRef = doc(db, "quotations", searchNo);
        const docSnap = await getDoc(docRef);

        if (!docSnap.exists()) return alert("查無此估價單號！");

        const data = docSnap.data();
        switchCompany(data.company);
        document.getElementById('quoteNo').value = data.quoteNo;
        document.getElementById('clientName').value = data.clientName;
        document.getElementById('salesSelect').value = data.salesCode;
        document.getElementById('quoteDate').value = data.date;

        const tbody = document.getElementById('quoteItems');
        tbody.innerHTML = '';
        data.items.forEach(item => addQuoteRow(item));
        calcTotal();
        alert("估價單調取完成！");
    } catch (e) {
        console.error("調取失敗：", e);
        alert("調取失敗！");
    }
}

// 儀器管理 - 儲存
async function saveEquipment() {
    const serial = document.getElementById('eqSerial').value.trim();
    if (!serial) return alert("請填寫儀器序號！");

    const eqData = {
        name: document.getElementById('eqName').value,
        brand: document.getElementById('eqBrand').value,
        serial: serial,
        client: document.getElementById('eqClient').value,
        sales: document.getElementById('eqSalesSelect').value,
        location: document.getElementById('eqLocation').value,
        cycle: parseInt(document.getElementById('eqCycle').value) || 6,
        lastDate: document.getElementById('eqLastDate').value
    };

    try {
        await setDoc(doc(db, "equipments", serial), eqData);
        alert("儀器資料已儲存！");
        loadEquipments();
    } catch (e) {
        console.error("儀器儲存失敗：", e);
    }
}

// 儀器管理 - 載入與保養提醒 (30天內)
async function loadEquipments() {
    try {
        const querySnapshot = await getDocs(collection(db, "equipments"));
        const tbody = document.getElementById('equipmentTableBody');
        const alertList = document.getElementById('alertList');
        if (!tbody || !alertList) return;

        tbody.innerHTML = '';
        alertList.innerHTML = '';

        const today = new Date();
        let hasAlert = false;

        querySnapshot.forEach((docSnap) => {
            const data = docSnap.data();
            if (!data.lastDate) return;

            const lastDate = new Date(data.lastDate);
            const nextDate = new Date(lastDate);
            nextDate.setMonth(nextDate.getMonth() + parseInt(data.cycle));

            const nextDateStr = nextDate.toISOString().split('T')[0];
            const diffDays = Math.ceil((nextDate - today) / (1000 * 60 * 60 * 24));

            if (diffDays <= 30) {
                hasAlert = true;
                alertList.innerHTML += `<li><b>${data.name}</b> (${data.client}) - 預計保養日：${nextDateStr} (剩餘 ${diffDays} 天)</li>`;
            }

            tbody.innerHTML += `
                <tr>
                    <td>${data.name}</td>
                    <td>${data.brand}</td>
                    <td>${data.serial}</td>
                    <td>${data.client}</td>
                    <td>${data.sales}</td>
                    <td>${data.location}</td>
                    <td>${data.cycle} 個月</td>
                    <td>${data.lastDate}</td>
                    <td style="${diffDays <= 30 ? 'color:red; font-weight:bold;' : ''}">${nextDateStr}</td>
                </tr>
            `;
        });

        const alertBox = document.getElementById('maintenanceAlertSection');
        if (alertBox) alertBox.style.display = hasAlert ? 'block' : 'none';
    } catch (e) {
        console.error("載入儀器資料失敗：", e);
    }
}

// 管理員 - 上傳業務名單 CSV
function uploadSalesCSV() {
    const file = document.getElementById('salesCsvFile').files[0];
    if (!file) return alert("請選擇 CSV 檔案！");

    Papa.parse(file, {
        header: true,
        complete: async function(results) {
            for (const row of results.data) {
                if (row.code) {
                    await setDoc(doc(db, "sales", row.code), {
                        name: row.name || '',
                        phone: row.phone || '',
                        code: row.code
                    });
                }
            }
            alert("業務名單更新成功！");
            loadSalesData();
        }
    });
}

// 管理員 - 上傳價格表 CSV
function uploadPriceCSV() {
    const file = document.getElementById('priceCsvFile').files[0];
    if (!file) return alert("請選擇 CSV 檔案！");

    Papa.parse(file, {
        header: true,
        complete: async function(results) {
            for (const row of results.data) {
                if (row.model) {
                    await setDoc(doc(db, "products", row.model), {
                        model: row.model,
                        nameEn: row.nameEn || '',
                        nameCn: row.nameCn || '',
                        brand: row.brand || '',
                        spec: row.spec || '',
                        price: parseFloat(row.price) || 0
                    });
                }
            }
            alert("價格表更新成功！");
            loadPriceData();
        }
    });
}