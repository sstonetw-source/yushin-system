/* Page help reads existing UI state and capability predicates only; no network reads. */
(function () {
    'use strict';
    const pages = {
        'quote-system': { title: '估價單', permission: 'quote', purpose: '製作估價單、三家比價與決標單價分析，查詢既有報價。', notes: ['儲存或匯出前，核對報價公司、品項與金額。', '成交後建立訂單；估價單本身不會扣庫存。', '搜尋涵蓋授權的歷史資料，清單預設先顯示近期紀錄。'] },
        'forecast-system': { title: 'Forecast', permission: 'forecast', purpose: '追蹤客戶案件、預估金額與成交進度。', notes: ['有新進展時更新進度，成交或未成交時結案。', 'Stage 1～5：需求確認、報價方案、預算申請、採購議價、成交交機。', '進行中持續追蹤；Win 為成交，Lost 為未成交。'] },
        'product-system': { title: '產品', permission: 'products', purpose: '搜尋產品、查看庫存，選品後帶入估價單、訂單或採購單。', notes: ['先選廠牌，再輸入完整貨號按搜尋；開頭的 0 必須保留。', '可跨搜尋選品，再一次帶入同一張單據。', '選擇廠牌不會載入產品；需要清單時按「瀏覽此廠牌產品」。'] },
        'order-system': { title: '訂單', permission: 'orders.list', purpose: '管理客戶訂單，追蹤採購、到貨、打單、送貨與核銷。', notes: ['可依品項分批處理；完成打單的品項可先送貨。', '核銷代表完成單據核銷，核銷日期不代表開票或收款日；可先核銷，不必等待全部送貨。', '取消或退貨前，確認畫面列出的採購與庫存影響。', '調撥途中須先確認收貨；取消或恢復若提示預留異常，請由管理員核對。'] },
        'purchasing-system': { title: '採購', permission: 'orders.po', purpose: '處理訂單採購、備貨及安全庫存補貨，追蹤採購單與到貨。', notes: ['建立採購前核對供應商、數量與成本；建立後列入待到貨。', '客戶取消訂單，不代表供應商採購也已取消；無法取消的貨到貨後成為庫存。', '完成打單後，客戶訂單仍須繼續送貨與核銷。'] },
        'inventory-system': { title: '倉庫', permission: 'inventory', purpose: '查看各倉庫庫存，辦理收貨、出貨、調撥與領貨。', notes: ['退貨申請不增加庫存，實際點收後才入庫。', '主倉自領由訂單負責業務按已送貨才扣帳；寄給負責業務後仍待送客戶；直接寄客戶的出貨會登錄已送貨，不代表客戶已簽收。', '主倉自領配到分倉庫存，才產生訂單調回需求；採購也可主動發起主倉備貨。'] },
        'equipment-system': { title: '儀器', permission: 'equipment', purpose: '管理客戶儀器與維修、保養、校正紀錄，追蹤下次到期日。', notes: ['批次匯入依儀器編號新增或更新，保留既有維修保養紀錄。', '匯出只包含目前已載入的篩選結果。', '儀器資料依歸屬維護；維修保養紀錄由工程師或管理員處理。'] },
        'admin-system': { title: '管理員後台', permission: 'admin', purpose: '管理人員、廠牌、價目表與倉庫設定，查看分析與執行資料維護。', notes: ['單一產品的日常操作請到「產品」頁面。', '資料檢查、備份與用量計算會讀取資料，需手動執行。', '刪除、清除資料或交接前，先核對預覽與確認訊息。'] }
    };
    const adminPages = {
        'admin-sales': { purpose: '查看人員帳號、角色與聯絡資訊，寄送密碼重設信。', notes: ['登入帳號在 Firebase Authentication 建立或停用。', '姓名、代號與角色需在使用者資料中一致設定。'] },
        'admin-agencies': { purpose: '管理廠牌標準名稱、別名、獨立統計與報價公司限制。', notes: ['常見縮寫放在別名，避免重複建立廠牌。', '未設獨立統計的廠牌，在分析中歸入其他廠牌。', '未限制報價公司時，三家公司均可報價。'] },
        'admin-products': { purpose: '上傳與刪除整批價目表，管理標準價格及成本。', notes: ['上傳前先核對新增、更新與錯誤預覽。', '新版只更新檔案內的品項；完全替換時先刪除舊價目表。', '刪除價目表不會刪除產品主檔、歷史單據或庫存。'] },
        'admin-statistics': { purpose: '查看採購、銷售與庫存分析，依條件篩選及匯出。', notes: ['先確認期間、廠牌與其他篩選條件。', '毛利以系統記錄的銷售金額與成本計算；缺少成本時須先補齊。'] },
        'admin-warehouses': { purpose: '管理倉庫、外倉及收件設定。', notes: ['出貨依實際庫存所在倉庫安排。', '外倉出貨請從倉庫出貨分頁處理。'] },
        'admin-health': { purpose: '檢查主檔缺漏、重複資料及訂單、採購、庫存關聯。', notes: ['這是唯讀檢查，不會修改或刪除資料。', '需讀取多個資料集合，請按需手動執行。'] },
        'admin-transfer': { purpose: '將業務代號交接給接手同仁。', notes: ['先檢查交接內容，再確認執行。', '交接依業務代號處理，保留歷史姓名與操作紀錄。'] },
        'admin-storage': { purpose: '備份與檢查資料庫，依需求清理測試資料。', notes: ['備份與用量計算會讀取全部資料，請按需執行。', '清除前核對保留範圍；永久清除無法直接復原。', '補回缺少的文件前，先檢查上傳備份內容。'] }
    };
    const visible = node => !!node && !node.hidden && node.getClientRects().length > 0;
    function section(body, title, lines) {
        const group = document.createElement('section');
        const heading = document.createElement('h4'); heading.textContent = title;
        const list = document.createElement('ul');
        lines.forEach(text => { const item = document.createElement('li'); item.textContent = text; list.append(item); });
        group.append(heading, list); body.append(group);
    }
    function roleNote(page) {
        if (typeof getPagePermission !== 'function') return '';
        const level = getPagePermission(page.permission);
        if (level === 'none') return '目前角色無此頁面的存取權限。';
        if (page.permission === 'products' && typeof canManagePendingProductMaster === 'function' && canManagePendingProductMaster()) return '可新增與編輯產品主檔；永久刪除限管理員。';
        return level === 'view' ? '目前角色可查看；資料修改由有操作權限的人員辦理。' : '';
    }
    function init() {
        const dialog = document.getElementById('pageHelpDialog');
        const body = document.getElementById('pageHelpBody');
        let trigger = null;
        document.addEventListener('click', event => {
            const button = event.target.closest('[data-page-help]');
            if (!button) return;
            const key = button.dataset.pageHelp, page = pages[key];
            const owner = document.getElementById(key);
            if (!page || !visible(owner)) return;
            trigger = button;
            document.getElementById('pageHelpTitle').textContent = page.title + '｜頁面說明';
            body.replaceChildren();
            const adminContext = key === 'admin-system' ? Object.keys(adminPages).find(id => visible(document.getElementById(id))) : '';
            const content = adminContext ? adminPages[adminContext] : page;
            section(body, '頁面功能', [content.purpose]);
            const restriction = roleNote(page);
            section(body, '注意事項', restriction ? [...content.notes, restriction] : content.notes);
            dialog.showModal();
            body.scrollTop = 0;
        });
        dialog.querySelector('[data-close-page-help]').addEventListener('click', () => dialog.close());
        dialog.addEventListener('click', event => {
            const rect = dialog.getBoundingClientRect();
            if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
        });
        dialog.addEventListener('close', () => { if (trigger?.isConnected) trigger.focus(); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
