# #268 手動採購的單筆唯讀對帳

正式 Carol QA 已有成功 UI 紀錄；本工具補足底層文件證據的取得管道，**工具通過測試不代表已查核正式資料或完成 #268 驗收**。

## 執行

在已具備對目標專案唯讀 IAM 權限及 Application Default Credentials 的管理環境，安裝既有 `functions/package.json` 依賴後執行：

```bash
node functions/scripts/audit-quick-purchase.js --project=yu-shing-company --order=qbCVc4f0PmsUgBnGm0Im --item=item-1793541854182-tieqp
```

目標來源只含一個原始採購事件時，從權威 Supply 取得其原 operationId；有多個事件則停止判定，不自行選最新事件。亦可用 `--operation=原操作編號` 精確比對。CLI 沒有 execute、修復、重試交易或刪除模式；不呼叫 Callable，不更改正式資料／角色／Rules／旗標。它是獨立管理腳本，不從 `functions/index.js` 匯出、不部署。

專案必須明列，僅接受 `yu-shing-company`、`preview-20135` 或 `demo-yushin`。前兩者拒絕 Firestore Emulator 環境；demo 則必須連本機 Emulator。允許專案名稱並非證明該專案存在、可存取或已取得寫入授權。缺少憑證／權限／連線時 exit 1，不能以空結果當通過。

## 證據及判定範圍

全部讀取在同一筆 **readOnly Firestore Transaction** 內進行，避免不同查詢時間誤判。輸出只含指定來源／原操作識別、布林檢查與判定，不輸出客戶、供應商、成本、email、Auth 憑證或原文件內容。

- Order 唯一來源品項／唯一原採購事件、採購時的 Supply 身分與原意圖 hash、purchaseOperations、Demand 身分及沿既有純核心重算的需求投影。
- 原 `inventoryMovements/quick-{operationId}` 的數量、來源、倉庫與操作者，並查詢該 Supply 的所有 movement，確認唯一在途紀錄。
- 公司庫存與該商品**全部分倉**的現有／預留／在途合計，以及指定分倉的採購在途覆蓋。公司總量可包含其他採購，不錯誤要求等於這一筆採購數量。
- 目前 actor 仍有採購權限。若已合法離職／停權，此項仍會標記不符，需人工區分歷史交易與目前身分；不能據此推論歷史操作未授權。

判定僅限**單次、尚未收貨的實體倉庫手動採購**：

| status | exit | 意義 |
| --- | --- | --- |
| CONSISTENT | 0 | 本次一致快照內，上列範圍全部相符 |
| MISMATCH | 2 | 缺文件或至少一項不符，需唯讀調查；沒有自動修復 |
| INCONCLUSIVE | 2 | 直送、收貨／取消後續生命週期、追加採購或查詢超過上限，不能沿本工具判定 |

分倉與來源 movement 各最多讀取 101 文件，超過 100 即明列無法判定，絕不以截斷結果宣稱一致。這不是全庫在途重算、正式角色 UI 驗收、成本隔離驗收或回覆遺失演練，不證明其他交易入口安全。

## 驗證與後續

單元回歸覆蓋遺失憑證、錯誤連結／hash、重複 movement、分倉加總不符、查詢上限、追加採購及敏感值不輸出。既有真 Auth／Functions／Firestore Emulator 的同一筆成功案例接續執行對帳，不新增採購提交，並確認 operation 文件 updateTime 不變。

正式執行完成後將結果記在 #268，再決定剩餘舊快取／Rules 邊界及結案條件；不能拿測試 fixture 或未執行的指令當正式證據。
