# PR #512 寄貨正式銜接驗收（2026-11-09，台北）

## 查核基準與結果

- 查核時遠端 main：`a4bebf3a708b3c14a5bacaa3dc93763bc3f981db`，PR #512 已合併。
- GitHub Pages：main 根目錄、HTTPS `https://sstonetw-source.github.io/yushin-system/`；不是 Firebase Hosting。Pages run `42494816589` 成功。
- main regression run `42494816800` 全部成功，含 source、兩組 Chrome browser、六組 Emulator、必要 regression gate。已查閱實際 job 日誌，不重跑未修改的既有 main 測試。
- 遠端 `index.html`、`app.js`、`transaction-rollout-config.js`、`modules/home-screen-install.js` 與 main 位元組一致。HTTP 快取為 `max-age=600`。專案沒有註冊 Service Worker；安裝引導未實作離線快取。已開啟的 Mac 網頁 App 不會自動替換記憶體中的程式，需關閉重開或重新載入；尚未對使用者的已安裝 App 執行現場驗證，勿清除站台資料或待確認操作。
- 正式 Rules 已唯讀比對與本次修改前 main 相同；release 更新時間 `2026-11-08T07:10:51.289042Z`。本次新增封鎖規則尚未部署。
- 正式專案：`yu-shing-company`，Firestore `(default)`；Functions 使用 `asia-east1`。
- 正式 Functions 清單中缺少 `dispatchOrderTransfer`、`handoffOrderTransfer`、`receiveOrderTransfer`。本次未部署。
- 三種 ORDER_TRANSFER 前端 BACKEND 與 LEGACY_BLOCKED 共六個旗標均為 false；本次未啟用。

## 原因與原交易唯讀核對

錯誤並非倉庫主檔停用。原預留為 `locationSchemaVersion=2`，舊 `runRoleTransaction` 不支援此位置格式，安全檢查拒絕。PR #512 補上正式後端通道及確定失敗的「寄貨已停止」回饋，但預設關閉正式切換。

訂單 `YS-20261108-N1-02` 儲存於 `orders/Xd3wDzy8nw4OWPHv6sjy`，單號欄位為 `quoteNo`。四筆預留中 Test3 與 test4 各預留 20，皆維持 active、位置版本 2。訂單寄貨／送貨紀錄皆空，依 orderId 查無 stockTransfers，只有最初 order_initial_reservation 憑證。

| 品項 | 公司現有／預留 | 分倉現有／預留 | 批次剩餘合計 |
| --- | --- | --- | --- |
| Test3 | 100／20 | 勝力 100／20；又鑫 0／0 | 100 |
| test4 | 70／20 | 又鑫 70／20；勝力 0／0 | 70 |

品項庫存流水中，本單只有預留；出貨扣庫紀錄屬於其他 orderId。此次查核未發現本單寄貨扣庫、部分寫入或重複扣庫證據。查詢每個相關品項最多 10 筆，實際返回均未達上限（Test3 5、test4 7 筆流水）。這是當次資料快照，非跨多次唯讀查詢的原子快照；執行前須再次核對，尤其需取得原瀏覽器 operationId，禁止另建新 ID 試扣庫。

## 新補齊的單一 writer 安全條件

只切前端旗標不足以封鎖快取舊程式。本次增加 `settings/orderTransferCutover.backendOnly` 單向閘門：

- Rules 阻止舊用戶端訂單關聯寄貨／交接與收貨寫入，保留非訂單自由庫存調撥。
- 正式後端在同一庫存交易內讀取該閘門；缺少、false 或非 boolean true 皆拒絕，不寫庫存。
- 關閉後端功能旗標會安全中止；不得將資料庫閘門改回 false 來恢復舊 writer。
- 沒有增加 listener、查詢索引、collection 或改變數量公式。每次正式交易增加一筆交易內設定讀取。
- 原固定角色、預留位置、批次成本追溯、原操作 ID、原子性及冪等驗證保留。

## 分開核准的正式操作清單

本文件不是部署授權。所有步驟須在新修正合併且 CI 成功後，以當時最新 main SHA 固定來源。

1. **後端部署（獨立核准）**：目標 `yu-shing-company` / `asia-east1`，僅部署 `dispatchOrderTransfer,handoffOrderTransfer,receiveOrderTransfer`，Node 22。部署命令只可明列 `--project yu-shing-company --only functions:dispatchOrderTransfer,functions:handoffOrderTransfer,functions:receiveOrderTransfer`。首輪三個 action flags 及 V2 flag 均不設或 false。正式寫入維持關閉；回讀函式版本、狀態與設定。失敗停止後續，不動庫存。
2. **Rules 部署（獨立核准）**：目標同專案 `(default)`；僅 `--only firestore:rules`，先比對當時正式 Rules 與最新 main，保存原 ruleset release。必須包含本次舊入口封鎖及不可反轉閘門。無需 Index 更新。部署失敗停止。啟用閘門後不可回復會重新開啟舊 writer 的 Rules 版本。
3. **舊入口封鎖（獨立核准）**：在確認 Rules 已發布後，設定唯一文件 `settings/orderTransferCutover` 的 `backendOnly=true`。這會暫停所有訂單關聯舊寄出、交接、收貨；不切一般自由庫存調撥。先盤點尚未完成的舊 stockTransfers 與原操作 ID，因新後端不接受缺少可信任憑證的舊單；不得直接重建或補單。驗證舊客戶端無法寫入、Rules閘門不可逆。回復方式是維持封鎖並修復後端，不恢復舊 writer。
4. **後端交易啟用（獨立核准）**：各對應函式設定 `ENABLE_PRODUCTION_ORDER_TRANSFER_DISPATCH_BACKEND=true`、`ENABLE_PRODUCTION_ORDER_TRANSFER_HANDOFF_BACKEND=true`、`ENABLE_PRODUCTION_ORDER_TRANSFER_RECEIVE_BACKEND=true`；涉及 V2 的三函式設定 `ENABLE_PRODUCTION_ORDER_TRANSFER_V2_BACKEND=true`。未設預設停用。核對所有 Project ID 為 `yu-shing-company`，無 Emulator 環境變數；Auth 使用真實登入，後端 users 角色僅 admin/purchaser/warehouse 且啟用。依限定函式更新，不使用廣域部署。錯誤則停用對應旗標，資料庫封鎖維持 true。
5. **前端交易切換（獨立核准）**：透過既有 GitHub Pages main 發布，三種 ORDER_TRANSFER 的 BACKEND 與 LEGACY_BLOCKED 成對設 true；僅限既有 HTTPS origin/path。這是正式交易切換，不屬於本次修正合併授權。發布後比對檔案，重新開啟 Mac App，驗證原登入身分與待確認操作。中止時 BACKEND=false、LEGACY_BLOCKED=true，絕不回復舊 writer。無需手動前端發布；若自動發布失敗，手動發布另行核准。
6. **原單現場驗收（獨立核准正式寫入）**：先以原帳號唯讀核對 sessionStorage 原操作 ID、憑證、庫存、負責業務及位置；已完成者只查結果，未完成者才用原 ID 執行一次。核對公司／分倉／批次／預留及寄貨記錄。測試環境成功不等於正式交易實測成功。不得使用正式庫存反覆測試；後續業務保管 V3 出貨／送達入口仍需獨立盤點，不能因交接成功宣稱整條客戶履約鏈已正式驗收。

所有正式資料修改／補正、刪除、重置均未授權；本次不需要也不執行。全程禁止 Firebase Hosting / Preview Channel。

## 上線判定

尚不可上線。前端版本已核實，但指定後端未部署、舊 writer 封鎖與正式切換尚未核准／執行、原帳號原操作 ID 與已安裝 App 現場驗收尚待完成。部署前程式與隔離驗證結果見本修正 PR 與 CI；正式交易驗收不得以 CI 取代。
