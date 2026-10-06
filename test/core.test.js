import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  verifyLineSignature, taipeiDayStart, evenly, pseudonyms, revealCodes,
  extractAiText, parseJsonText, scoreRanking,
  botMentionPrompt, dailyAiLimit, rankingText, rankingSample, discussionContext, conversationalInput, conversationalReply, requestedSearch, lookupMemoryQuestion, prepareConversationMemory,
} from "../src/core.js";

globalThis.crypto ||= webcrypto;

test('明確查詢前綴進行搜尋，普通互嗆不觸發；邀請者不得猜測',()=>{
  assert.equal(requestedSearch('請你查詢回應我 某產品是否已正式上市'),'某產品是否已正式上市');
  assert.equal(requestedSearch('幫我查一下：今天的消息'),'今天的消息');
  assert.equal(requestedSearch('搜尋 最新消息'),'最新消息');
  for(const question of ['你他媽','最後一班船是去哪','不要查詢這件事']) assert.equal(requestedSearch(question),null);
  assert.match(conversationalReply('洋流號拉我進來的啦',conversationalInput('你是誰拉進群組的',[])),/沒顯示誰拉我進來/);
});

test('雲端實測的假防踢能力与調查時間猜測改為合理回覆，差距使用百分點',()=>{
  const joke=conversationalReply('我可是群組裡的防踢系統，你踢得動嗎？',{reply_intent:'banter'});
  assert.match(joke,/領便當/);
  assert.ok(!joke.includes('防踢'));
  const input={question:'所以甲會贏？',reply_intent:'poll_followup',recent_bot_turns:[{answer:'調查日期：來源片段未提供'}]};
  const answer=conversationalReply('甲目前支持度46.8%，乙46.1%，差距不到2%，這是那份民調，不能確定勝負。',input);
  assert.match(answer,/差距不到2個百分點/);
  assert.ok(!answer.includes('目前'));
  assert.match(conversationalReply('這份民調不能保證當選，畢竟選戰還很久。',input),/不能這樣推/);
});

test('時效資料的自然問法自動搜尋，但資料解讀與概念題不重複搜索',()=>{
  for(const question of ['台北市市長選舉本日民調','台北市市長選舉民調','今天的新聞','最新 EDA 工具版本']) assert.equal(requestedSearch(question),question);
  for(const question of ['民調是什麼','台北選舉民調的抽樣誤差怎麼看','那這份民調怎麼看？','今天加班好累','不要搜尋最新民調']) assert.equal(requestedSearch(question),null);
});

test('舊查證不直接進入解讀背景；長查詢保存版本與主題且不讓使用者重複註記',()=>{
  const input=conversationalInput('所以誰會贏？',[]);
  prepareConversationMemory(input,[{question:'查證台北選舉民調',answer:'🔎 民調資料整理｜以色列的結果'}]);
  assert.deepEqual(input.recent_bot_turns,[]);
  const text=lookupMemoryQuestion('x'.repeat(1000)+'\n查詢版本：old\n查詢主題：錯誤', '台北民調'+'y'.repeat(1000));
  assert.ok(text.length<=500);
  assert.ok(!text.includes('查詢版本：old'));
  assert.match(text,/查詢主題：台北民調/);
  assert.match(text,/查詢版本：sourced-v2/);
});

test("打氣不得新增道歉或酸民故事，不能承諾代替聯絡人", () => {
  const input=conversationalInput('幫成員丙加油打氣一下',[]);
  for(const reply of ['你願意誠懇道歉，這份態度值得肯定。','別被那些酸民搞到心煩啦！','你已經做得很好，我們都支持你。']) {
    assert.equal(conversationalReply(reply,input),'成員丙，加油啦！嘴砲可以輸，氣勢不能輸 😎');
  }
  assert.equal(conversationalReply('成員甲，撐住啦！',conversationalInput('幫成員甲加油',[])),'成員甲，撐住啦！');
  assert.match(conversationalReply('要不我幫你去問問看？',conversationalInput('為什麼成員乙還在加班？',[])),/沒辦法代你去問人/);
});

test("不同人物各自選取背景，Bot 要求不冒充人物事實", () => {
  const now=Math.floor(Date.now()/1000);
  const rows=[
    {user_id:'a',ts:now-4,text:'成員乙還在加班。'},
    {user_id:'b',ts:now-3,text:'@AI群聊助手 幫成員甲加油打氣一下'},
    {user_id:'a',ts:now-2,text:'@AI群聊助手 幫成員丙加油打氣一下'},
    {user_id:'b',ts:now-1,text:'成員甲剛剛在討論票價。'},
  ];
  const cheer=conversationalInput('幫成員丙加油打氣一下',rows);
  assert.equal(cheer.reply_intent,'encouragement');
  assert.equal(cheer.target_name,'成員丙');
  assert.equal(cheer.recent_discussion,'');
  const overtime=conversationalInput('為什麼成員乙還在加班？',rows);
  assert.equal(overtime.target_name,'成員乙');
  assert.match(overtime.recent_discussion,/成員乙/);
  assert.ok(!overtime.recent_discussion.includes('成員甲'));
  const roast=conversationalInput('叫成員甲別耍白痴了 成員丙就是屌 誰要投成員丁',rows);
  assert.equal(roast.reply_intent,'roast');
  assert.equal(roast.target_name,'成員甲');
  assert.ok(!roast.recent_discussion.includes('加班'));
  assert.match(conversationalInput('你覺得呢',rows).recent_discussion,/票價/);
});

test("群組背景保留最近完整訊息及時序，不洩漏原始 ID 或被連續重複洗掉", () => {
  const rows=[
    {user_id:'private-1',ts:1,text:'舊話題'.repeat(100)},
    {user_id:'private-2',ts:2,text:'現在談公車班次與候車時間。'},
    {user_id:'private-2',ts:3,text:'現在談公車班次與候車時間。'},
    {user_id:'private-1',ts:4,text:'免費票價之外也要看班次能否維持。'},
  ];
  const context=discussionContext(rows,120);
  assert.ok(!context.includes('舊話題'));
  assert.ok(!context.includes('private-'));
  assert.equal(context.match(/現在談公車班次/g).length,1);
  assert.ok(context.indexOf('現在談公車')<context.indexOf('免費票價'));
  assert.equal(context.split('\n').length,2);
  assert.ok(context.startsWith('['));
});

test("問候與測試不因 Bot 名稱變長而被當作實質戰力發言", () => {
  for (const text of ["@AI群聊助手 你好", "@AI群聊助手 你好你好！😀", "@AI hello hello", "/AI 請分析兩方理由", "測試一下", "！😀"]) assert.equal(rankingText(text), null);
  assert.equal(rankingText("@朋友 我認為應該先提出資料，再比較各方理由。"), "我認為應該先提出資料，再比較各方理由。");
  assert.ok(rankingText("你好，關於預算這件事我有不同看法。"));
  assert.ok(rankingText("幹，這個說法完全沒有附任何原始數據。"));
});

test("長期戰力均衡覆蓋成員與期間，重複洗版不能湊門檻", () => {
  const rows = Array.from({length: 12}, (_, person) => Array.from({length: 50}, (_, index) => ({
    message_id: `${person}-${index}`, user_id: `u${person}`, ts: index, text: `討論編號 ${index}：應該提出原始資料支持這項主張。`,
  }))).flat();
  const result = rankingSample(rows);
  assert.equal(result.selected.length, 240);
  for (let person=0; person<12; person++) {
    const sample=result.selected.filter(r=>r.user_id===`u${person}`);
    assert.equal(sample.length, 20);
    assert.equal(sample[0].ts, 0);
    assert.equal(sample.at(-1).ts, 49);
  }
  assert.equal(rankingSample(rows.slice(0,50)).selected.length,30);
  assert.equal(rankingSample([1,2,3].map(i=>({message_id:`${i}`,user_id:'u',ts:i,text:'同樣主張一直重複也不能湊成三則。'}))).eligible.length,0);
});

test("只有標註 Bot 才觸發，UTF-16 位移保留其他文字", () => {
  const text = "😀 @戰報AI 這個論點呢？";
  assert.equal(botMentionPrompt({ text, mention: { mentionees: [
    { type: "user", isSelf: true, index: 3, length: 5 },
  ] } }), "😀  這個論點呢？");
  assert.equal(botMentionPrompt({ text, mention: { mentionees: [
    { type: "all", index: 3, length: 5 },
    { type: "user", userId: "other", index: 3, length: 5 },
  ] } }, "bot"), null);
  assert.equal(botMentionPrompt({ text: "@AI hi", mention: { mentionees: [
    { type: "user", userId: "bot", index: 0, length: 3 },
  ] } }, "bot"), "hi");
  assert.equal(botMentionPrompt({ text: "@AI", mention: { mentionees: [
    { type: "user", isSelf: true, index: 0, length: 999 },
  ] } }), null);
});

test("每日額度預設 300，無效設定不會取消保護", () => {
  assert.equal(dailyAiLimit(), 300);
  assert.equal(dailyAiLimit({ DAILY_AI_LIMIT: "500" }), 500);
  for (const value of ["bad", "0", "-1", "2.5", "10001"]) {
    assert.equal(dailyAiLimit({ DAILY_AI_LIMIT: value }), 300);
  }
});

test("僅接受正式回答，不把空回應或內部推理傳到群組", () => {
  assert.equal(extractAiText({ response: null, choices: [{ message: { content: "\n回答", reasoning: "internal" } }] }), "回答");
  assert.equal(extractAiText({ response: "<think>internal</think>回答" }), "回答");
  for (const result of [{ response: "" }, { choices: [{ message: { content: null, reasoning: "internal" } }] }, { response: "<think>unfinished" }]) {
    assert.throws(() => extractAiText(result));
  }
});

test("LINE 簽章只接受原始內容", async () => {
  const body = new TextEncoder().encode('{"events":[]}');
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  const sig = btoa(String.fromCharCode(...bytes));
  assert.equal(await verifyLineSignature("secret", body, sig), true);
  assert.equal(await verifyLineSignature("secret", new TextEncoder().encode('{"events":[]} '), sig), false);
});

test("台灣日期從午夜開始", () => {
  assert.equal(taipeiDayStart(Date.parse("2026-10-04T16:00:00Z")), Date.parse("2026-10-04T16:00:00Z") / 1000);
  assert.equal(taipeiDayStart(Date.parse("2026-10-04T15:59:59Z")), Date.parse("2026-10-03T16:00:00Z") / 1000);
});

test("採樣覆蓋首尾且代號可替換", () => {
  assert.deepEqual(evenly([0, 1, 2, 3, 4], 3), [0, 2, 4]);
  const codes = pseudonyms([{ user_id: "u1" }, { user_id: "u2" }, { user_id: "u1" }]);
  assert.equal(codes.get("u2"), "P2");
  assert.equal(revealCodes("P1：同意 P2。", new Map([["P1", "甲"], ["P2", "乙"]])), "甲：同意 乙。");
});

test("只接受可驗證的評分與本人例句", () => {
  const codes = new Map([["u1", "P1"]]);
  const evidence = new Map([["m1", { code: "P1" }], ["m2", { code: "P2" }]]);
  const parsed = parseJsonText('```json\n{"participants":[{"id":"P1","clarity":99,"responsiveness":-2,"evidence":10,"logic":9,"interaction":3,"evidence_ids":["fake","m2","m1"],"reason":"有主張"}]}\n```');
  const items = scoreRanking(parsed, codes, evidence);
  assert.equal(items[0].total, 47);
  assert.deepEqual(items[0].proof, ["m1"]);
  assert.equal(extractAiText({ response: "摘要" }), "摘要");
});
