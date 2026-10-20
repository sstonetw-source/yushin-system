// 三個公司的估價專用章圖片，直接以 Base64 內嵌（避免產生 PDF 時外部圖片造成畫布跨來源污染，無法匯出）
const STAMP_YUSHIN = "assets/stamps/yushin.png";
const STAMP_MORNINGSTAR = "assets/stamps/morningstar.png";
const STAMP_MULTI_LIFE = "assets/stamps/multi-life.png";


// app.js - 估價單系統 / 儀器管理系統 核心邏輯

const FIREBASE_CONFIGS = Object.freeze({
    production: {
        apiKey: "AIzaSyAmGAU2spWI54ujLyIFTWiX-mXyuau7Vps",
        authDomain: "yu-shing-company.firebaseapp.com",
        projectId: "yu-shing-company",
        storageBucket: "yu-shing-company.firebasestorage.app",
        messagingSenderId: "22622213823",
        appId: "1:22622213823:web:c3f0a9c367a88e271ed80a",
        measurementId: "G-861X26VW6M"
    },
    emulator: {
        apiKey: 'fake-api-key',
        authDomain: 'demo-yushin.firebaseapp.com',
        projectId: 'demo-yushin',
        appId: 'yushin-local-emulator'
    },
    preview: {
        apiKey: "AIzaSyDSbSZiwiHmdgi6146vqpfE84JgWU1KhK8",
        authDomain: "preview-20135.firebaseapp.com",
        projectId: "preview-20135",
        storageBucket: "preview-20135.firebasestorage.app",
        messagingSenderId: "546566883230",
        appId: "1:546566883230:web:396c28f1f01ada0a1c788f"
    }
});

function resolveAppEnvironment() {
    const host = String(window.location.hostname || '').toLowerCase();
    if (['localhost','127.0.0.1'].includes(host) && window.YUSHIN_LOCAL_EMULATOR === true) return 'emulator';
    return host === 'preview-20135.web.app' || host === 'preview-20135.firebaseapp.com'
        ? 'preview'
        : 'production';
}
const APP_ENVIRONMENT = resolveAppEnvironment();
const firebaseConfig = FIREBASE_CONFIGS[APP_ENVIRONMENT];

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
if (APP_ENVIRONMENT === 'emulator' && firebase.app().options.projectId !== 'demo-yushin') {
    throw new Error('本機 Emulator 不可沿用其他專案的 Firebase app。');
}
const db = firebase.firestore();

// 這套系統在部分實際使用網路環境持續出現 Firestore WebChannel transport error。
// Firebase 官方提供 forceLongPolling 用於避開 Proxy／防毒／網路設備對長連線的相容性問題。
// 必須在任何 Firestore 讀寫前設定；不要同時啟用 autoDetectLongPolling。
try {
    db.settings({
        experimentalForceLongPolling: true,
        useFetchStreams: false
    });
} catch (err) {
    console.warn('Firestore long polling 設定未套用：', err);
}
if (APP_ENVIRONMENT === 'emulator') {
    firebase.auth().useEmulator('http://127.0.0.1:9099', { disableWarnings: true });
    db.useEmulator('127.0.0.1',8080);
    if (firebase.functions) firebase.app().functions('asia-east1').useEmulator('127.0.0.1',5001);
}
if (APP_ENVIRONMENT === 'preview' || APP_ENVIRONMENT === 'emulator') {
    document.documentElement.dataset.appEnvironment = APP_ENVIRONMENT;
    window.addEventListener('DOMContentLoaded', () => {
        const banner = document.getElementById('previewEnvironmentBanner');
        if (banner) {
            if (APP_ENVIRONMENT === 'emulator') banner.textContent = '本機 Emulator｜隔離測試資料，未連接正式 Firebase';
            banner.hidden = false;
        }
    });
}

// 啟動時由 SDK 還原既有 session；手動登入前才指定 LOCAL，避免 iOS 初始化競爭。
// iPhone 主畫面網站有自己的儲存空間；請求持續保存可降低系統回收登入資料的機率。
let homeScreenStoragePersistencePromise = null;
function requestHomeScreenStoragePersistence() {
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
    if (!standalone || !navigator.storage?.persist || homeScreenStoragePersistencePromise) return;
    homeScreenStoragePersistencePromise = Promise.resolve()
        .then(() => navigator.storage.persisted?.() || false)
        .then(persisted => persisted || navigator.storage.persist())
        .catch(err => console.warn('主畫面網站儲存保留未啟用：', err));
}

