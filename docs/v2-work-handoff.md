# V2 Work Mode 交接

## 2026-10-22 — 原多品項合併採購與分倉分單（待本批完整 CI）

- 原畫面確認合併 PO 後必須重新載入待採購需求；只清空前端需求快取而不重新查詢，會讓另一倉尚未採購的 I2 在本頁暫時消失。修正限定於採購成功且目前正顯示待採購頁時重查一次；隱藏分頁不額外讀取。此案例以桌機及手機 CI 實際驗收為準。

- #219 已於 CI 39704261677 全綠後合併 main `639d91a`：2226 項、零失敗／略過，另 10 組桌機／手機 Chrome smoke。保留三品項收貨、打單、跨倉出貨及送達成果，不重做交易核心。
- 本批移除該原站案例預先提交 PO／登記在途的 Service fixture，改為真登入採購，從待採購勾選 I1／I2 驗證跨倉拒絕且零寫入；同倉 I1／I3 合併製作 DRAFT 文件，再明確確認已採購。成功回覆中斷後重整並以原文件／完整品項意圖恢復，另倉 I2 由原單行入口分開採購。
- 預期兩張 PO、三筆 supply；公司在途 P=5／Q=2，各倉分別 3／2／2／0，不動實貨。文件及 PDF 不改訂單需求／承諾／庫存；同產品相鄰 B 行不得被 A 倉合併採購覆寫。採購後繼續原收貨至送達的完整案例，不降低既有斷言。
- 僅改測試與文件，無新 writer、讀取、Collection、Rules、Index、正式 Functions 匯出或部署。來源建單與 v2 初始化仍為明確 fixture；手動建單 UI、初始化真 Auth 傳輸、跨品項取消退貨及 Preview／正式環境尚未全面驗收。
- 本機 Node 1678 項及生成一致性通過；真 Auth／原站／Emulator／Rules 需以本批最新完整 CI 為準，通過才合併。

## 2026-10-22 — 多品項原畫面完整履約（待本批完整 CI）

- #218 已合併 main `34b4060`，CI 39699503371：2223 項通過、零失敗／略過，另 10 組 Chrome smoke；多品項真 Auth 收貨與原站分批實收已驗收。
- 本批延伸同一 1280／390px 三品項來源：採購逐品項原畫面打單、倉管依 A／B 實際倉出貨、原業務逐品項確認送達，預期三份打單／三筆實扣／三筆送達、共七件完成，實貨與來源預留歸零。
- 第二品項打單／出貨、第二及最後品項送達均丟失成功回覆；重整原角色並使用原 ID／品項／倉／批次確認，包含全單已完成後的最後確認。同產品相鄰品項不得覆蓋，送達不得再扣庫存，既有收貨／供應／採購需求不得改寫。
- 首輪 CI 39701456675：58／60，1280px 送達找不到來源訂單、390px 採購頁被「倉庫出貨紀錄來源不一致或重複」阻擋，未合併。共同原因為 procurementDemandForOrderItem 將整單出貨事件傳給單品項核心。修正沿用 projectOrderShipmentReturns 先驗證整單，再依 itemId 分配事件；使用原始 items 預留／缺口，避免顯示 normalizer 將待送達誤當待出庫。app 與 receiving runtime 均由既有工具重新生成。
- 新增三項執行回歸：首品項寄出後全部品項仍可呈現、同產品兩倉及異產品全送達零新需求、非選取品項事件異常也拒絕。沒有新增交易 writer、公式、資料模型、Rules、查詢、Listener、正式 Functions 匯出或部署。來源、三行採購及在途仍由原 Service fixture 準備，不能宣稱手動建單／合併採購 UI、退貨取消與正式環境全面驗收完成。
- 本機全部 Node 1678 項通過、零失敗／略過，建置一致性及 diff 通過；完整 CI 仍待修正後最新 head，通過才合併。

## 2026-10-22 — 多品項收貨登入轉接與原畫面（待本批完整 CI）

- #217 已合併 main `d057597`，CI 39696507503：2219 項、零失敗／略過，另 10 組 Chrome smoke；同來源最後3件已完成原畫面打單、出貨、送達與成功回覆中斷重試。
- 原 Receiving Service 已完整支援 1–5 品項，但 receiveV2Supply 登入轉接仍拒絕多品項。本批只讓正常、已完成 v2 初始化的 1–5 品項進入原權威驗證；取消仍未開放，沒有新增 writer 或數量公式。
- 新增真 Auth 驗收：同 PO 五行跨兩張 3／2 品項訂單、同產品相鄰品項並行收貨與最後餘量競爭、不同角色與意圖拒絕、已出貨／送達同單另一品項後續收貨、非選取品項的異產品實扣憑證損壞及整單來源失配零寫入。
- 新增1280／390px原整站收貨：三品項（同產品分兩倉、另一產品）、第一與最後分批成功回覆中斷及重整原ID重試，四筆receipt／lot、在途歸零、未打單／出貨／送達。此段採購單與在途由既有Service準備為fixture，不能宣稱合併採購UI或完整多品項履約已驗收。
- 本機Node1675項通過。完整真Auth／Chrome／Emulator／Rules須以本批最新CI為準，全綠才合併。未新增Collection／Rules／Index／Listener／正式Functions匯出，未部署Firebase、未改正式資料或角色。

## 2026-10-22 — 同來源最後 3 件履約（待本批完整 CI）

- #216 已合併 main `30500e2`，CI 39694406977：2217 項、零失敗／略過，另 10 組 Chrome smoke。已核實他倉 2＋3 送達與未知回覆重試。
- 本批接續同一 1280／390px 原站來源：原採購最後打單3，原來源倉出3，原業務送達3。三次均成功後丟棄 HTTP 回覆、重整以原 ID 確認，預期只增加一份打單、一份實貨出庫及一筆送達。
- 發現最後一次送達已成功時 remaining=0，原表單即使有凍結意圖也拒絕開啟；本批只允許有原 checkpoint 的 v2 已完成訂單重新確認。沒有 checkpoint、取消、角色不符及 legacy gate 仍阻擋新送達。
- 最終歷史出貨／確認各12、CLOSE退貨4、未履約及待確認0、來源預留／缺貨0，商業履約完成；保留兩倉／批次／成本憑證、兩張 PO、七筆目標預留與退貨事實驗證。核銷、正式部署、多品項與其他尚存邊界不在本批完成宣告內。
- 本機 Node 1675 項通過，完整 CI 待最新 head。未新增交易 writer／數量公式、資料模型、Rules、Index、Listener、正式 Functions 匯出或部署。

## 2026-10-22 — 他倉續出後原業務送達（待本批完整 CI）

- 最新 main 為 #215 合併 `28fb68d`；其 CI 39630659686 已全數成功：2213 項、零失敗／略過，另 10 組 Chrome smoke。舊「待 CI」段落屬施工歷史，以此已核實結果為準。
- 本批延續同一原站來源，從另一倉出貨 5 件後，原負責業務以原「分批交貨」表單確認 2＋3；兩次均模擬成功回覆中斷、重整後原 ID 重試。驗證不重複送達、不再扣庫存、保留原 CLOSE 退貨與剩餘 3 件未履約。
- 發現前次送達待確認時日期／數量／備註仍可編輯，與 Service 凍結意圖不一致；本批僅在既有 v2 Emulator UI 鎖定原值，結果確認後解除，保留原唯一送達 Service。
- 首輪 CI 39693307620 的原站案例在他倉出貨後缺少「分批交貨」入口，54／56，未合併。原因為原選單用尚可出庫數而非待確認送達數；出庫用完打單額度後 shippable=0，入口錯誤消失。本批以既有 Core 的 pendingDeliveryQty 及凍結重試判斷 v2 入口，完成送達後只保留原意圖確認，無新數量公式；新增四項 Node 回歸。取消、無效來源、未完成同步與 REPLACE 限制保留。
- 未新增 writer／資料模型／Rules／Index／Listener／正式 Functions 匯出或 Firebase 部署。真 Auth、Chrome 原站與 Rules 須以本批最新 head 完整 CI 為準。多品項、最後 3 件履約、Preview／正式啟用仍未由本批驗收。

## 2026-10-21 — 他倉續出原介面整合（待本批完整 CI）

- #213 已合併：製作／編輯 DRAFT 採購文件獨立，只有「確認已採購」提交交易與在途；#214 已合併，完整 CI 2205 項通過，原站已驗收履約／CLOSE 退貨後第二張 PO 的 1＋2 分批實收及未知回覆重試。
- 本批在原出貨清單讀取 inventoryReservations 的權威位置，按倉庫分列、選取與確認；保留原 Shipment Service，沒有新 writer。只限 localhost demo-yushin 的既有 Shipment Emulator gate、CUSTOMER_SHIP，其他模式維持原流程。
- 一次最多核對 200 個品項，每批 20 個 server 點讀，不新增 Listener／Index／Collection／Rules。檢查真 Auth、角色、來源／產品／預留一致性；讀取失敗、帳號切換或版本過期不猜回來源倉。未知回覆仍顯示原倉／原數量，重送同 ID。
- 原 1280／390px 整站驗收接續第二張 PO 實收後，由另一倉出 5 件、丟失成功回覆、重整原列重試；來源倉不變、另一倉實扣一次、其他需求／目標訂單／送達／退貨不變。送達總數仍為 4，總出貨增為 9，尚有來源倉預留 3；不能宣稱全部履約完成。
- 本機 Node 1669／1669 通過，完整 Chrome／真 Auth／Emulator／Rules 以本批最新 CI 為準，通過才合併。未部署 Firebase，未修改正式資料與角色；多品項、剩餘送達及 Preview／正式啟用仍須後續驗收。

## 2026-10-20 整站啟動驗收
- 本批詳見 [完整首頁 Emulator 啟動驗收](full-site-emulator-boot-20261020.md)。保留原元件驗收，再增加原整站啟動與五角色恢復，CI 全綠前不可合併。
- 不部署正式 Firebase、不變更真實角色或 provider；正式環境全流程仍另有發布 gate。

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

本批首次 CI 39627998910 在原站出貨列遇到背景重新讀取後未重畫的問題（54／56），未合併。修正原工作佇列 finally 在庫存頁重畫出貨清單，等待位置核對完成才顯示；新增非同步回歸測試，原站測試也等待清單與倉庫主檔就緒後選倉。其餘斷言與權威交易驗證保留，須以新 head 完整 CI 判定。

第二輪 CI 39629304557 診斷確認更深層原因：出貨後 normalizedOrderItems 的 legacy display shortage 與原始 items.shortageQty 不同，位置核對不可把顯示投影當原帳。本批改用原始來源 item 數量核對與版本失效，保留既有 normalize 與後端公式；新增出貨後投影差異回歸。前述兩輪皆非驗收完成，待新 head 完整 CI。
