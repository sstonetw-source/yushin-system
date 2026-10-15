# 多位置預留模型與交易接線邊界

2026-10-15 接續：現行交易與 Rules 增加[位置模型相容性保護](reservation-location-compatibility-20261015.md)，在全流程接線完成前阻止新版欄位進入舊單倉寫入路徑。這是啟用前防護，並未實作或開放多倉交易。

基準：main `686f596b`（PR #78；前一階段 PR #77 `1a70a448`）。沿用 PR #78 的 `validateMultiLocationLedger` 與 `locations[].reservedQty`，沒有另建第二套位置驗證。本批完成純資料模型與交易增減量提案，**沒有啟用新的 Firestore 寫入，也沒有完成多倉預留或分批交付**。現有畫面、權限及正式資料維持原流程。既有跨倉合併阻擋仍保留。

## 權威資料

保留 `inventoryReservations/{orderId}__{itemId}` 一筆預留，不增設 Collection 或第二套庫存帳。提案中的位置欄位為：

```json
{
  "locationSchemaVersion": 2,
  "locations": [
    {"warehouseId": "A", "reservedQty": 4},
    {"warehouseId": "B", "reservedQty": 6}
  ],
  "quantity": 10,
  "shortageQty": 0,
  "status": "active"
}
```

同一倉只允許一列正整數；`quantity` 必須等於各倉數量總和。品項總預留仍是必要的投影，不能另外獨立修改。`warehouseId` 未定義成多倉的代表倉，也不能拿任一倉承接整筆數量。

`reservationLocations` 唯讀轉譯舊 `warehouseId + quantity`，不批量遷移舊單。未知版本、未標版本的位置陣列、總量不符或重複位置都停止，不能退回舊格式後覆寫。業務保管／調撥中預留仍須由其專屬履約流程處理，不能交一般實體倉配置器重新配置。

## 共用計算

`planLocationReservation` 接收同一產品的公司庫存、候選倉主檔、分倉庫存、既有預留、尚待交付量與供應商已下訂待到貨量，回傳：

- `reservation`：上述位置與總量提案。
- `warehouseDeltas`：各倉 reserved 的增減，沒有變動的倉不列出。
- `companyReservedDelta`：公司 reserved 增減，必須等於分倉增減總和。
- `remainingToOrderQty`：實貨缺口扣除供應商待到貨，最低為零。

已有預留先留在原位置，不依快取或較大庫存搬倉；縮量時依固定倉 ID 排序保留，再釋放超額。新增量依提示倉、預設倉、倉 ID 分配。停用實體倉既有預留可釋放，不能追加；保管位置不可使用本配置器。可用量重用 `inventory-core.normalizeStock`，同時受公司可用量限制，排除自由調撥途中量。採購在途不能當作現貨，也不能讓新增預留重複覆蓋已下訂量；既有預留遇供應超額不擅自修復歷史資料。

所有輸入與舊預留保持不變；負數、非有限數字、錯產品／位置、缺少既有足量分倉、公司預留不足會拒絕產生提案。數量沿用 PR #78 的安全整數限制；舊單總量的數字字串可轉譯，新版 locations 的 reservedQty 必須為數字整數。這是交易內計算工具，**不是寫入授權、併發鎖或庫存修復工具**。

## 啟用前必須同批完成

| 現行入口／證據 | 接線要求 |
|---|---|
| app.js `reserveSingleOrderItem` | 同交易重讀訂單、需求、公司／各倉、預留與倉庫主檔；依最新數量重算，原子寫入各倉增減、總預留、品項投影及需求 |
| app.js `allocateFreeReceiptStockToShortages`、`receiveSupplyOrderRecord` | 只增加實際到貨倉的預留，不把其他倉配置覆蓋；保留收貨 checkpoint 與 FIFO |
| app.js `applyInventoryDeliveryDeltaInTransaction`、快速送貨及 `warehouse-logistics.js` | 選定實際來源位置／數量，只扣該倉；保留批次成本、打單額度及業務保管責任 |
| app.js 訂單取消／恢復、`customer-cancellations.js` | 每個位置釋放／還原，不以品項總數更新單一倉；沿用待分配版本與退貨品質隔離 |
| `stock-permissions.js` | 公司與各倉差額證據改讀同一預留中的位置量；不能沿用整筆 quantity 代表單一倉 |
| firestore.rules `validReservationSource`、`operationalReservationDeltaAt`、`sameWarehouseReservationDeltaAt`、業務寫入憑證 | 同步驗證版本、位置唯一性、數量上限、總量、角色及同交易庫存差額；保留舊單規則，控制規則運算／跨文件讀取上限 |
| 列表、詳情、打單、需求位置 | 多位置不能繼續顯示為單一倉可出貨；未到貨的採購目的倉須獨立明確 |

交易回呼可能重跑：不得把舊提案或前次結果帶進下一輪；先讀後寫，登入身份／角色變動停止。只有後端確認提交成功才更新畫面；回覆遺失後重讀權威預留，套用後再重算應為零增減。新位置模型不得提前寫入現行正式資料，因舊履約與 Rules 尚未支援。

## 本批驗證與後續

本機新增 26 項行為測試，涵蓋舊單相容、重新計算、部分釋放、取消目標零、供應商在途、公司上限、調撥途中、停用與保管位置、資料異常、非整數拒絕、數量守恆及瀏覽器腳本全域依賴。守恆測試內含 1,100 組整數情境，屬純計算驗證，不是 1,100 次資料庫交易。兩張訂單測試依序套用最新快照，**不代表真正 Firestore 併發已驗證**。

本機語法、diff 檢查與完整 1,047 項應用回歸通過。VM 的瀏覽器腳本依賴測試不是實際 Chrome 操作驗收。未新增 Query、Listener、Index、角色或正式寫入，不需要因本批部署 Rules／Index。桌面／手機與既有 Emulator 回歸由 PR CI 確認；新增模型未接線，不能以現有規則測試通過宣稱新模型安全規則已驗收。正式環境未測試、未部署，歷史資料未修復。

下一階段：上述交易入口與 Rules 相容改造、實際函式 Emulator 的原子性／併發／角色拒絕驗收，完成後才解除多倉阻擋；接續各倉分批出貨與業務領貨。歷史資料修復及既有未結案稽核清單仍保留。
