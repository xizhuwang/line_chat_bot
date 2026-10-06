# LINE Chat Bot

部署在 Cloudflare 的 LINE 群聊助手，提供 AI 問答、聊天室摘要、論述表現排行、公開資訊核對與天氣預報。程式、資料庫與模型都在雲端，部署後不需要持續開著個人電腦。

此儲存庫是經過去識別化的程式備份。範例人物均為虛構；設定使用占位值，使用者須自行建立服務與提供密鑰。預設為通用聊天及工程討論，不包含特定群組、人物或立場設定。

## 功能

| 用法 | 功能 |
| --- | --- |
| LINE 的 `@` 選取 Bot＋問題，或 `/AI 問題` | 結合近期文字背景回答；支援電機、數位 IC、類比 IC |
| `/懶人包` | 當日聊天摘要 |
| `/本週` | 最近七天摘要 |
| `/戰力`、`/今日戰力`、`/本月戰力` | 最近七天、當日、最近三十天的論述表現排行 |
| `/查證 說法` | 搜尋公開來源，再核對說法並附來源連結 |
| `/查證 台北明天天氣` | 城市代表點的全天預報；缺城市先追問 |
| `/用量`、`/狀態`、`/說明` | 用量、啟用狀態與使用說明 |
| `/我的ID` | 私訊 Bot 取得自己的 LINE 識別 ID，供管理員設定 |
| `/退出統計`、`/加入統計` | 刪除個人已存文字並退出，或重新加入後續記錄 |
| `/啟用`、`/停用`、`/清除群組資料` | 管理員控制群組記錄與資料刪除 |

只處理 Bot 加入且管理員啟用後的新文字訊息，無法讀取過去的 LINE 歷史。圖片、貼圖、錄音及檔案不納入摘要。一般聊天只存入資料庫，明確呼叫功能才分析。

論述排行不等於事實裁定或人的價值。每位成員至少三則不同的實質發言才符合門檻；指令、問候、測試及重複洗版排除。每人最多三十則，均衡涵蓋期間與成員；總採樣最多二百四十則。

## 架構

```text
LINE 群組 → HTTPS Webhook → Cloudflare Worker → D1
                                 ├─ Workers AI：問答、摘要、排行、來源分析
                                 ├─ Tavily：公開資料搜尋（選用）
                                 └─ Open-Meteo：地名及天氣預報
                           → LINE reply 回覆
```

| 路徑 | 說明 |
| --- | --- |
| `src/index.js` | Webhook、群組控制、D1 操作、模型調用與 LINE 回覆 |
| `src/core.js` | 簽章、採樣、代號、接話意圖、回答驗證及重複檢查 |
| `src/prompts.js` | 通用聊天與工程提示詞 |
| `src/factcheck.js` | 搜尋、來源整理、核對提示詞與回覆格式 |
| `src/weather.js` | 城市解析、台灣日期計算與天氣資料驗證 |
| `schema.sql` | 七張資料表與索引，無私人資料或 INSERT 範例 |
| `test/` | 核心函式與使用記憶體 SQLite 的 Webhook 測試 |
| `wrangler.example.jsonc` | 不含真實帳號或資料庫 ID 的部署模板 |

## 執行需求

- Node.js **24 或更新版本**：測試使用內建 `node:sqlite`。
- 套件管理器：npm 或 pnpm；儲存庫提供 `pnpm-lock.yaml`。
- Cloudflare 帳號，並建立 Worker、D1 與 Workers AI 綁定。
- LINE 官方帳號，啟用 Messaging API。
- 若使用網頁查證，另需 Tavily 金鑰；不設定時，其餘功能仍可使用。

```sh
git clone https://github.com/xizhuwang/line_chat_bot.git
cd line_chat_bot
pnpm install --frozen-lockfile
pnpm test
```

若使用 npm，執行 `npm install` 和 `npm test`。測試不需要外部金鑰、不連線服務商；目前 **64 項通過**。它們包含簽章、退出及刪除、記憶清除、提問換人、近似重複、搜尋路由、日期與錯誤預報資料。

## 部署步驟

### 1. 建立 Cloudflare 設定與資料庫

把 `wrangler.example.jsonc` 複製為 `wrangler.jsonc`，後者已加入 `.gitignore`。以自己的帳號執行：

```sh
npx wrangler login
npx wrangler d1 create line-chat-db
```

把回傳的 `database_id` 填入本機 `wrangler.jsonc`。如自行更改資料庫名稱，也須同步更新設定與遷移命令。接著建立資料表：

```sh
npx wrangler d1 execute line-chat-db --remote --file=./schema.sql
```

### 2. 設定 LINE 與密鑰

在 [LINE Official Account Manager](https://manager.line.biz/) 建立官方帳號、啟用 Messaging API，再於 [LINE Developers Console](https://developers.line.biz/console/) 開啟群組邀請。取得自己的 Channel secret 與 Channel access token，逐一以互動輸入方式儲存：

```sh
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put ADMIN_USER_IDS
```

`ADMIN_USER_IDS` 是可執行管理指令的 LINE 使用者 ID，逗號分隔多位管理員。部署後可由管理員私訊 Bot 輸入 `/我的ID` 取得並補設定。不要把 ID 或密鑰寫入程式、Git commit、issue 或 README。

若需要網頁查證，另外設定：

```sh
npx wrangler secret put TAVILY_API_KEY
```

本機開發可將 `.dev.vars.example` 複製為 `.dev.vars`，只在自己的電腦填入；正式部署仍使用 Worker Secrets。

### 3. 發布與連接 Webhook

```sh
npx wrangler deploy
```

將實際發布網址加上 `/webhook` 填入 LINE Developers 的 Webhook URL；Verify 成功後開啟 Use webhook，建議開啟 Webhook redelivery、關閉官方帳號預設自動回覆以避免重複。`GET /health` 應回傳 `ok`。

將 Bot 邀入群組，告知成員記錄與分析方式後，由已設定的管理員輸入 `/啟用`。測試標註問答、`/用量` 與 `/查證 台北明天天氣`。

部署說明：[Cloudflare Workers](https://developers.cloudflare.com/workers/)、[D1](https://developers.cloudflare.com/d1/)、[LINE 群組與 Webhook](https://developers.line.biz/en/docs/messaging-api/group-chats/)。

## 費用與限制

本程式沒有自動升級方案、充值或付費回退。請自行保持各服務免費方案，尤其不要啟用搜尋服務的自動付費。

- 預設每群每天 `300` 次 AI 分析，台灣午夜重置；不是服務商承諾的免費次數。Workers AI 的實際免費運算額度另行計算，可能更早用完。
- Tavily 預設全 Bot 每月最多 `900` 次 basic 搜尋。此計數限同一資料庫；其他程式使用同一金鑰也會消耗服務商額度。
- 天氣不使用 AI 或 Tavily，仍受天氣服務自身頻率限制。私人非商用情境須遵守 [Open-Meteo 條款](https://open-meteo.com/en/terms)。
- 使用 LINE reply 回覆；LINE、Worker、D1、AI 與搜尋服務的方案與限制各自適用，程式的計數不能保證所有帳號都零費用。

可在本機 `wrangler.jsonc` 調整 `DAILY_AI_LIMIT` 與 `SEARCH_MONTHLY_LIMIT`，再部署；服務商額度用完時沒有換用付費模型的程式。

## 資料與隱私保護

儲存庫只包含程式、空結構與虛構測試資料。沒有群組對話匯出、資料庫備份、登入憑證、正式端點或真實管理員 ID。

實際執行時仍會處理聊天資料，部署者應先向成員說明：

- 管理員啟用後儲存文字原文、群組 ID、成員 ID 與時間；原文保留三十天，每日清理。
- 同群、同一提問者最近一小時最多四輪問答可用於接話。每輪保存提問前五百字元與回答前一千字元；過期記憶每日清理，不是滿一小時立即從硬碟刪除。
- `/退出統計` 刪除該成員已存文字；收回刪除對應原文、編輯更新對應原文、離群刪除該成員原文，並清除本群問答記憶。`/停用` 停止記錄並清除問答記憶；要立即刪除群組已存文字，使用 `/清除群組資料`。已發送到 LINE 的回覆無法由此指令撤回。
- 送到 Workers AI 的群組背景會將使用者 ID 換成代號；文字中的姓名或其他個資**不保證全數匿名化**。
- Tavily 只收到本次待核對說法，不收到聊天歷史。程式移除部分 ID、email、@名稱與金鑰格式，不保證移除所有個資。
- Open-Meteo 收到城市名與城市代表點座標，不收到群組 ID、使用者 ID 或聊天歷史。

避免把個資、公司內部資料或未公開設計規格送給 Bot。保留同意、退出與刪除機制，不要為了備份移除這些保護。

## 回覆與功能客製

在 `src/prompts.js` 調整通用聊天及工程口吻。預設較直球、帶朋友式吐槽，認真求助與要求溫和時收斂；吐槽不能取代解答或捏造人物事實。

此範例把 `AIC` 定義為 Analog IC／類比 IC；這是可修改的專案用語設定，不主張所有領域都採同一縮寫。重問會帶入相關問答，高度近似回覆改用不同例子；被指出重複時會先認帳再補充解釋。

天氣目前支援台北、新北、桃園、台中、台南、高雄、基隆、新竹、嘉義、苗栗、彰化、南投、宜蘭、花蓮、台東、屏東的今明後天預報，採城市代表點，不是街道或山區精細預報。來源：[Open-Meteo](https://open-meteo.com/)、[GeoNames](https://www.geonames.org/)；重大天氣警報請看 [中央氣象署](https://www.cwa.gov.tw/)。

AI 仍可能答錯或接話不自然；技術規格以原廠文件及實際條件核對。查證只分析搜尋片段，不等於讀取全文。Webhook 後台任務與 reply token 有時間限制，模型太慢時可能無法完成回覆。

## 更新：任務承接與回嘴

省略主題的「你查啊／阿」在同群同人一小時內有近期查詢時會沿用主題，只把主題送搜尋。換成新任務後不重新搜尋無關舊題。調查資料追問會承接來源，方法、日期、樣本與誤差不齊時明示；數字結果不能直接當成未來結果的保證。要求少講髒話立即收斂，後續同人的近期對話沿用偏好，可再要求恢復吐槽。互鬧保留短句回嘴與接梗，不聲稱有防踢權限或能代執行群組操作。

## 時效查詢

明確時效資料的自然問法可自動搜尋，不必每次加「查證」。本日與近期調查使用一次 basic 搜尋並檢查來源日期，沒有符合日期的結果時不呼叫模型猜答案。搜尋服務日期可能是更新日期，不等於原始發布日期；今天更新的報導也不等於今天進行了新調查。來源若引用不同年份調查，不輸出成當期數字。方法或原理問題仍可直接回答，不自動重搜。人物更正可在同群同人近期查詢主題下重新核對，不把更正本身視為已證實事實。

## 更新：自然新聞問法與短句查詢

「台北市新聞」等自然問法會查近期資料。台灣中文查詢設定語言與地區，並檢查來源是否提到指定城市；不相關國外結果不傳給模型。回覆先講重點，日期或方法缺口集中成一句，來源只列實際使用的最多兩篇。調查數字須有來源逐字片段，街訪、網路投票與評論各自標示，不混成一份結果。「現在是甲跟乙誰會贏」在已有相關調查的情況下承接解读，不誤判為人物更正。這些篩選不能保證來源本身正確，仍須核對原始資料。
