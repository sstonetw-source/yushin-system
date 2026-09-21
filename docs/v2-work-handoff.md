# V2 Work Mode 交接

使用者明天只需說「繼續」。不要重新討論需求，直接依本文件與 v2-upgrade-plan.md 施工。

## 起點
Repository: sstonetw-source/yushin-system
正式 main 基準：7cf91049ac3dee5b24b9560241d941f24e648c6e
工作 branch：upgrade/v2-fulfillment-20260920

## 明天施工順序
1. 重新確認 main 是否有新 commit；若有，先比較，不可用舊版覆蓋。
2. 從 Phase A 開始，先完成 item/qty fulfillment core，再做 UI。
3. 每個小段：inspect exact functions -> targeted edit -> syntax/tests -> commit。
4. 不整份重寫 app.js；app.js 很大，優先局部修改，安全時才逐步模組化。
5. 不直接寫 production Firestore data。
6. Firestore schema/rules/indexes 變更先在 branch，列出需使用者發布的項目。
7. Phase A 自動測試通過後再進 Phase B；不要把未測大改推 main。
8. 所有長操作加 feedback/progress；所有寫入按鈕防 double-submit。
9. 所有新 query 避免 full collection historical reads。
10. Quote number logic 禁止修改。

## 已知 main 技術債
- main 已有 items[]、normalizedOrderItems、item-level reservation、部分採購/收貨/送貨基礎。
- 手動新增/複製訂單 UI 仍偏 single-item。
- 部分 cancel/restore/return/quick delivery 還有 whole-order legacy。
- order list 仍混有 isOrdered/isArrived/isDelivered legacy status。
- search/brand/PO display 仍可能只看 top-level first item。
- purchaser PO 仍是主要 ordering model，尚缺 sales self-order generic supply record。
- 尚缺 purchaser 待打單 -> 已打單 -> sales 可出貨 的正式 qty-level flow。
- analytics 尚未完全依 Inventory Lot actual batch COGS。
- product-line owner price upload/permission 尚未完成。
- admin Dashboard 尚未完成新版 action-card model。
- PR #26 有 FEFO/lot allocation/atomic transaction/rules/index/test 可參考，但由舊 main 分支，不可直接 merge；需重套適用部分。
- PR #29 的多品項內容已進 main；不要再次疊加。

## 人工操作留到最後
- production Firestore backup
- production rules/index deploy（若連線無 deploy 權限）
- 真實庫存/期初成本/安全庫存資料
- 產品線負責人確認
- Firebase Auth 新帳號必要操作
- 公司既有出貨系統實際打單驗收
- Desktop/iPhone 五角色實測
