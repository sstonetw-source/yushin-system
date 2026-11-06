# 歷史需求完成度總表

首輪清查基準為 2026-11-05 的 [main f7f0be0](https://github.com/sstonetw-source/yushin-system/commit/f7f0be0bcf3c643e1aa0b98cf6ca5b4920b3dfab)。比對 Git 歷史、469 筆 GitHub Issue／PR 條目（20 張 Issue、449 個 PR）、歷史驗收、發布紀錄與正式 Pages 靜態檔案。正式 Pages 的 index、app、樣式及地址模組均與該 main 一致。需登入的頁面與交易，以已有的正式操作紀錄判定。這是可查證的 30 項基線，往後在同一份表更新。

同一需求的重複修正共用一列。日期有直接需求紀錄時採提出日，只有版本或 Issue 證據時列「可追溯至」，未知則標示待查。發布分前端與後端。驗收「待驗證」表示缺少對應版本及正式角色證據，既有隔離測試可沿用。已確認取消、暫緩或取代的規格各自列明。

| 需求 | 提出日期或最早可追溯日 | 優先級 | Issue／PR 或原始碼 | 開發 | 合併 | 正式發布 | 驗收 | 剩餘工作 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 正式新單權威預留、公司／分倉一致 | 2026-10-28 起可追溯 | P0 | [#311](https://github.com/sstonetw-source/yushin-system/issues/311)、[#433](https://github.com/sstonetw-source/yushin-system/pull/433)、[#444](https://github.com/sstonetw-source/yushin-system/pull/444) | 完成 | main | 已發布 | 原漏列情境已驗，期初／整體另列 | 由整體上線追蹤新期初帳 |
| 手動訂貨的正式採購角色 403 | 2026-10-25 可追溯 | P0 | [#268](https://github.com/sstonetw-source/yushin-system/issues/268)、[#426](https://github.com/sstonetw-source/yushin-system/pull/426)、[#429](https://github.com/sstonetw-source/yushin-system/pull/429) | 完成 | main | 已發布 | 已正式驗收 | 跨流程角色驗收留 #291 |
| 正式 PO 確認與在途 | 2026-10-22 可追溯 | P0 | [#199](https://github.com/sstonetw-source/yushin-system/issues/199)、[#448](https://github.com/sstonetw-source/yushin-system/pull/448)、[#450](https://github.com/sstonetw-source/yushin-system/pull/450)、[#451](https://github.com/sstonetw-source/yushin-system/pull/451) | 完成 | main | 已發布 | 待驗證 | 一般客戶 PO、多品項、原操作重試及拒絕 |
| 倉庫收貨、分批與原憑證 | 2026-10-27 可追溯 | P0 | [#308](https://github.com/sstonetw-source/yushin-system/issues/308)、[#432](https://github.com/sstonetw-source/yushin-system/pull/432)、[#444](https://github.com/sstonetw-source/yushin-system/pull/444) | 完成 | main | 已發布 | 待驗證 | 真倉管一般 PO、分批、最後一批及重試 |
| 打單與實際出貨分開、實際出貨才扣庫 | 2026-10-28 可追溯 | P0 | [#328](https://github.com/sstonetw-source/yushin-system/issues/328)、[#439](https://github.com/sstonetw-source/yushin-system/pull/439)、[#440](https://github.com/sstonetw-source/yushin-system/pull/440)、[#444](https://github.com/sstonetw-source/yushin-system/pull/444) | 完成 | main | 已發布 | 待驗證 | 真倉管桌機／手機打單、出貨及重試 |
| 送達與撤銷 | 2026-10-28 可追溯 | P0 | [#330](https://github.com/sstonetw-source/yushin-system/issues/330)、[#443](https://github.com/sstonetw-source/yushin-system/pull/443)、[#444](https://github.com/sstonetw-source/yushin-system/pull/444) | 完成 | main | 已發布 | 待驗證 | 真角色完成雙向，核對出貨與庫存 |
| 訂單取消及恢復 | 2026-10-28 可追溯 | P0 | [#333](https://github.com/sstonetw-source/yushin-system/issues/333)、[#441](https://github.com/sstonetw-source/yushin-system/pull/441)、[#444](https://github.com/sstonetw-source/yushin-system/pull/444) | 完成 | main | 已發布 | 失敗單取消已驗，其餘待驗證 | 正常來源取消、恢復、部分履約後憑證 |
| 客退入庫、批次與申請撤回 | 2026-10-28 可追溯 | P0 | [#347](https://github.com/sstonetw-source/yushin-system/issues/347)、[#442](https://github.com/sstonetw-source/yushin-system/pull/442)、[#444](https://github.com/sstonetw-source/yushin-system/pull/444) | 部分 | main | 支援範圍已發布 | 待驗證 | RESTOCKABLE/CLOSE 的角色實測，區分其他未開放情境 |
| 切換後舊版 writer 拒絕、正式角色與期初庫存 | 2026-11-01 可追溯 | P0 | [#291](https://github.com/sstonetw-source/yushin-system/issues/291)、[#443](https://github.com/sstonetw-source/yushin-system/pull/443)、[#444](https://github.com/sstonetw-source/yushin-system/pull/444) | 部分 | main | 主要實體路由已發布 | 待驗證 | 真實期初數量、五角色及中止／恢復 |
| 產品可選服務及子類型 | 2026-11-05 | P1 | [#469](https://github.com/sstonetw-source/yushin-system/pull/469) | 完成 | main | 前端已發布 | 390／1280px 隔離驗證，正式角色待驗證 | 正式新建主檔納入 #471 |
| 純服務及混合單開案、分批、全單完工、核銷 | 2026-10-23 可追溯 | P1 | [#234](https://github.com/sstonetw-source/yushin-system/issues/234)、[#241](https://github.com/sstonetw-source/yushin-system/issues/241)、[#471](https://github.com/sstonetw-source/yushin-system/issues/471) | 部分 | 原核心已進 main，候選 [#472](https://github.com/sstonetw-source/yushin-system/pull/472) | 服務作業未發布 | 已有真 Auth 建單及案件分段測試，正式待驗證 | 同一張新建單串到核銷、四類服務角色及受控啟用 |
| 客戶常用地址、另存、即時更新、個人地址分流 | 2026-11-04 | P1 | [#275](https://github.com/sstonetw-source/yushin-system/issues/275)、[#300](https://github.com/sstonetw-source/yushin-system/pull/300)、[#470](https://github.com/sstonetw-source/yushin-system/pull/470) | 完成 | main（#470） | 已發布，正式資產與 fc05648 一致 | 定向及 CI 通過，正式角色待驗證 | 正式角色建單、加入地址及下次重開選取 |
| 倉庫快速點收 | 2026-11-01 | P1 | [#308](https://github.com/sstonetw-source/yushin-system/issues/308)、[#464](https://github.com/sstonetw-source/yushin-system/pull/464)、[#466](https://github.com/sstonetw-source/yushin-system/pull/466) | 完成 | main | 已發布 | 直接備庫部分收貨已驗，完整角色路徑待驗證 | 原待到貨入口、實收量、完成、錯誤和重試 |
| 無來源訂單直接採購、待到貨及部分收貨 | 2026-11-04 | P1 | [#464](https://github.com/sstonetw-source/yushin-system/pull/464)、[#466](https://github.com/sstonetw-source/yushin-system/pull/466)、[#467](https://github.com/sstonetw-source/yushin-system/pull/467)、[驗收紀錄](direct-stock-receipt-proof-20261105.md) | 完成 | main | 已發布 | 正式採購 3／實收 1 已驗，前端修正重試待驗證 | 用原操作確認解除待確認，避免再入庫 |
| 直接採購草稿／確認／下載分離、選倉與成本率 | 2026-11-05 可追溯 | P1 | [#467](https://github.com/sstonetw-source/yushin-system/pull/467)、[測試](releases/order-purchase-interface-20261105.md) | 完成 | main | 前端已發布 | 隔離通過，正式待驗證 | 採購角色桌機／手機依新按鈕確認 |
| 採購四分頁、成本率與含稅金額對帳 | 2026-11-06 | P1 | [#483](https://github.com/sstonetw-source/yushin-system/issues/483)、[#467](https://github.com/sstonetw-source/yushin-system/pull/467) | 已實作 | 依 #483 關聯 PR | 待查核 Pages 版本 | 正式資料待驗 | 用採購／管理員帳號核對部分採購、部分到貨與交易方式 |
| 訂單整單交付、貨號／廠牌順序與品項編輯 | 2026-11-04 | P1 | [#460](https://github.com/sstonetw-source/yushin-system/pull/460) | 完成 | main | 前端已發布 | 已有三品項隔離測試，正式待驗證 | 沿用既有功能，地址與交付驗收合併執行 |
| 直開發票必填發票抬頭 | 2026-11-04 | P1 | [#459](https://github.com/sstonetw-source/yushin-system/pull/459) | 完成 | main | 前端已發布 | 正式角色待驗證 | 新單表單與既有拒絕測試 |
| 無印章估價單 | 2026-11-04 | P1 | [#455](https://github.com/sstonetw-source/yushin-system/pull/455) | 完成 | main | 前端已發布 | PDF 定向通過，手機實際下載待驗證 | 正式手機開檔 |
| PDF 直接下載、移除網站分享選單 | 2026-11-04 | P1 | [#456](https://github.com/sstonetw-source/yushin-system/pull/456)、[#60](https://github.com/sstonetw-source/yushin-system/issues/60) | 完成 | main | 前端已發布 | 定向通過，手機實際下載待驗證 | Safari 預覽的分享內容由裝置決定 |
| 估價單廠牌留白及字重一致 | 2026-11-05 | P2 | [#468](https://github.com/sstonetw-source/yushin-system/pull/468)、[#469](https://github.com/sstonetw-source/yushin-system/pull/469) | 完成 | main | 前端已發布 | 隔離桌機／手機通過，正式角色待驗證 | 沿用 #469 |
| 估價單廠牌預設文字「廠牌」 | 2026-11-04 可追溯 | P2 | [#465](https://github.com/sstonetw-source/yushin-system/pull/465)、[#469](https://github.com/sstonetw-source/yushin-system/pull/469) | 被新版取代 | 新版已進 main | 新版已發布 | 已比對新版資產 | 無，採預設留白 |
| 產品主檔中／英文必填及管理欄簡化 | 2026-11-05 | P1 | [#469](https://github.com/sstonetw-source/yushin-system/pull/469) | 完成 | main | 前端已發布 | 隔離通過，正式角色待驗證 | 正式角色測新建與拒絕 |
| 地址貼紙去單號、移除出貨清單列印 | 2026-11-05 | P2 | [#469](https://github.com/sstonetw-source/yushin-system/pull/469) | 完成 | main | 前端已發布 | 隔離通過，正式實物輸出待驗證 | 沿用地址貼紙及 CSV |
| 訂單客戶卡片、狀態標題與進度／採購文字 | 2026-11-04 | P2 | [#458](https://github.com/sstonetw-source/yushin-system/pull/458)、[#461](https://github.com/sstonetw-source/yushin-system/pull/461)、[#462](https://github.com/sstonetw-source/yushin-system/pull/462)、[#463](https://github.com/sstonetw-source/yushin-system/pull/463)、[#467](https://github.com/sstonetw-source/yushin-system/pull/467) | 完成 | main | 前端已發布 | 定向通過，正式資產已核對 | 依使用者指示，低風險顯示調整無獨立正式驗收 |
| 儀器資料、保養／維修、日期、到期／逾期及匯出入 | 2026-10-12 可追溯 | P2 | [#55](https://github.com/sstonetw-source/yushin-system/issues/55)、[儀器工作區](../src/features/equipment/equipment-workspace.js) | 部分 | main | 頁面已發布 | 真角色待驗證 | 核對客戶篩選、序號重複／並行與主動通知範圍；30 天狀態提示已存在 |
| 人員資料及停用、客戶／儀器／文件關聯與交接 | 2026-10-12 可追溯 | P2 | [#454](https://github.com/sstonetw-source/yushin-system/pull/454)、[管理工作區](../src/features/administration/user-and-system-settings.js) | 部分 | main | 前端已發布，交接 Callable 待驗證 | 待驗證 | 正式交接版本及真角色；保留既有 salesCode、歷史姓名與建立者 |
| 管理員後台及固定角色權限 | 2026-11-01 | P2 | [#452](https://github.com/sstonetw-source/yushin-system/pull/452)、[#454](https://github.com/sstonetw-source/yushin-system/pull/454)、[角色](../src/app/role-capabilities.js)、[Rules](../firestore.rules) | 部分 | main | 已發布既有角色及頁面 | 待驗證 | 剩餘匯出／管理操作逐角色對照；沿用已移除的瀏覽器資料重置入口 |
| 管理員可編輯逐功能 CRUD／匯出矩陣 | 2026-11-05 可追溯 | P2 | [固定角色](../src/app/role-capabilities.js) | 未實作 | 未合併 | 未發布 | 未驗 | 獨立後續需求，須先確認權限政策 |
| 成本底層隔離 | 2026-10-06 可追溯 | P2 | [#31](https://github.com/sstonetw-source/yushin-system/issues/31) | 已同意暫緩 | 原固定角色已進 main | 既有範圍已發布 | 完整隔離待驗證 | 依 #31 既有決策 |
| 價格表與庫存表匯入減少讀寫／傳輸 | 2026-11-01 | P2 | [產品匯入](../src/features/products/product-master-import.js)、[品牌管理](../src/features/administration/brand-settings.js) | 既有匯入，效能證據待驗證 | main | 既有匯入已發布 | 待驗證 | 正式角色操作與差異集讀寫量 |

## 維護方式

- 接受需求時更新或加入對應列，保留原提出日期，沿同一個 Issue 追蹤同一商業問題。
- PR 提交時更新開發與合併欄。合併後依實際 Pages／Firebase 證據更新發布欄，記錄必要角色與操作結果後再更新驗收。
- 關閉 Issue 前先連上已驗證證據。若原範圍主要工作已完成，先在適合的 Open Issue 保留剩餘工作及驗收條件，並在原 Issue 留交接連結。
