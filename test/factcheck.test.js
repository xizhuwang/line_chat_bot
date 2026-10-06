import test from "node:test";
import assert from "node:assert/strict";
import { searchQuery, normalizeSources, renderFactCheck, searchMonthlyLimit, filterSearchSources } from "../src/factcheck.js";

test("搜尋不傳 LINE ID、email 或金鑰，且限制長度", () => {
  const query = searchQuery(`U00000000000000000000000000000000 foo@example.com tvly-secret @小明 最新預算 ${"x".repeat(500)}`);
  assert.ok(!query.includes("U000") && !query.includes("example.com") && !query.includes("tvly-") && !query.includes("@小明"));
  assert.equal(query.length, 350);
  assert.equal(searchMonthlyLimit({ SEARCH_MONTHLY_LIMIT: "2000" }), 900);
});

test("來源限有效公開 HTTPS 搜尋結果並去重", () => {
  const sources = normalizeSources([
    { url: "javascript:alert(1)", content: "bad" },
    { url: "https://user:pass@example.com/", content: "bad" },
    { url: "https://law.moj.gov.tw/test", title: "官方資料", content: "法條片段" },
    { url: "https://law.moj.gov.tw/test", content: "duplicate" },
    { url: "https://example.com/empty", content: "" },
  ]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, "S1");
});

test("虛構來源無法產生肯定真假結論，連結由程式組裝", () => {
  const sources = normalizeSources([{ url: "https://law.moj.gov.tw/test", title: "官方資料", content: "法條片段" }]);
  const bad = renderFactCheck({ verdict: "supported", points: [{ text: "正確", source_ids: ["S99"] }] }, sources);
  assert.match(bad, /資料不足/);
  const good = renderFactCheck({ verdict: "mixed", points: [{ text: "需補充條件", source_ids: ["S1", "S99"] }] }, sources);
  assert.match(good, /需補充條件/);
  assert.match(good, /https:\/\/law\.moj\.gov\.tw\/test/);
  assert.ok(!good.includes("S99"));
});

test('民調方法資訊必須能在引用片段找到，不猜調查日期或誤差',()=>{
  const sources=normalizeSources([{url:'https://example.com/survey',title:'某研究社調查',published_date:'2026-10-06',content:'某研究社在2026/10/1至2026/10/3，以電話訪問1000人，抽樣誤差±3.1%。甲支持度46.8%。'}]);
  const parsed={verdict:'supported',points:[{text:'甲支持度46.8%。',source_ids:['S1'],evidence_quote:'甲支持度46.8%。'}],survey:{source_ids:['S1'],organization:'某研究社',fieldwork_dates:'2026/10/1至2026/10/3',sample_size:'1000人',method:'電話訪問',margin_of_error:'±3.1%'}};
  const good=renderFactCheck(parsed,sources,Date.now(),{claim:'台北選舉民調'});
  assert.match(good,/調查日期：2026\/10\/1至2026\/10\/3/);
  assert.match(good,/樣本：1000人/);
  assert.match(good,/抽樣誤差：±3.1%/);
  const fabricated=renderFactCheck({...parsed,survey:{source_ids:['S1'],fieldwork_dates:'2026/10/6',sample_size:'2000人',margin_of_error:'±1.0%'}},sources,Date.now(),{claim:'民調'});
  assert.match(fabricated,/調查日期或方法沒附完整/);
  assert.ok(!fabricated.includes('2000人')&&!fabricated.includes('±1.0%'));
  assert.doesNotThrow(()=>renderFactCheck({...parsed,survey:{source_ids:'S1'}},sources,Date.now(),{claim:'民調'}));
});

test('本日與近期來源依台灣日期排除昨天、舊年、未來及未知日期；歷史查詢保留',()=>{
  const now=Date.parse('2026-10-05T17:10:00Z');
  const sources=normalizeSources([
    {url:'https://example.com/today',published_date:'Mon, 05 Oct 2026 17:00:00 GMT',content:'本地今天'},
    {url:'https://example.com/yesterday',published_date:'2026-10-05',content:'昨天'},
    {url:'https://example.com/old',published_date:'2022-09-01',content:'過往'},
    {url:'https://example.com/future',published_date:'2026-10-07',content:'未來'},
    {url:'https://example.com/undated',content:'未知'},
  ]);
  assert.deepEqual(filterSearchSources(sources,'本日民調',now).map(s=>s.url),['https://example.com/today']);
  assert.equal(filterSearchSources(sources,'最新民調',now).length,2);
  assert.equal(filterSearchSources(sources,'2022年民調',now).length,5);
});

test('今天更新的報導引用2022調查，不把歷史數字顯示為當期民調',()=>{
  const sources=normalizeSources([{url:'https://example.com/history',published_date:'2026-10-06',title:'回顧調查',content:'2022/9/1至2022/9/3調查，甲支持度40%。'}]);
  const result=renderFactCheck({verdict:'supported',survey:{source_ids:['S1'],fieldwork_dates:'2022/9/1至2022/9/3'},points:[{text:'甲支持度40%。',source_ids:['S1']}]},sources,Date.parse('2026-10-06T03:00:00Z'),{claim:'最新民調'});
  assert.match(result,/其他年份的調查/);
  assert.ok(!result.includes('40%'));
  assert.match(result,/可能是更新日期/);
});

test('台北查詢不把以色列選舉或其他城市來源交給模型，臺台字形皆可匹配',()=>{
  const sources=normalizeSources([
    {url:'https://example.com/israel',title:'Israeli election polls',content:'Likud and Yashar',published_date:'2026-10-05'},
    {url:'https://example.com/kao',title:'高雄市長民調',content:'高雄選民調查',published_date:'2026-10-05'},
    {url:'https://example.com/taipei',title:'臺北市長民調',content:'臺北市選民',published_date:'2026-10-05'},
  ]);
  assert.deepEqual(filterSearchSources(sources,'台北選舉民調',Date.parse('2026-10-06T03:00:00Z')).map(s=>s.url),['https://example.com/taipei']);
});

test('正式報導、街訪和評論不拼成一份民調；省略 survey 仍只選同一來源',()=>{
  const sources=normalizeSources([
    {url:'https://example.com/street',title:'台北街頭民調',content:'街訪甲30票、乙19票。'},
    {url:'https://example.com/report',title:'台北市調查結果',content:'甲46.8%，乙46.1%。'},
    {url:'https://example.com/comment',title:'觀點》聲量追蹤',content:'聲量甲500筆。'},
  ]);
  const result=renderFactCheck({points:[
    {text:'甲30票、乙19票。',source_ids:['S1'],evidence_quote:'甲30票、乙19票。'},
    {text:'報導轉述甲46.8%，乙46.1%。',source_ids:['S2'],evidence_quote:'甲46.8%，乙46.1%。'},
  ]},sources,Date.now(),{claim:'台北選舉民調'});
  assert.match(result,/46.8%/);
  assert.ok(!/30票|19票|street|未提供｜|支持度與看好/u.test(result));
  const street=renderFactCheck({points:[{text:'街訪甲30票。',source_ids:['S1'],evidence_quote:'街訪甲30票、乙19票。'}]},sources.slice(0,1),Date.now(),{claim:'民調'});
  assert.match(street,/街訪.*不能|代表全市選民/u);
});

test('民調数字必須有逐字原文與對應數字，不能編出差距、誤差或別份結果',()=>{
  const sources=normalizeSources([{url:'https://example.com/report',title:'台北調查',content:'甲46.8%，乙46.1%。'}]);
  const result=renderFactCheck({points:[
    {text:'甲46.8%，乙46.1%。',source_ids:['S1'],evidence_quote:'甲46.8%，乙46.1%。'},
    {text:'甲49.9%。',source_ids:['S1'],evidence_quote:'甲46.8%，乙46.1%。'},
    {text:'乙48.1%。',source_ids:['S1']},
  ]},sources,Date.now(),{claim:'民調'});
  assert.match(result,/46.8%/);
  assert.ok(!/49.9|48.1/u.test(result));
});

test('實際模型出現的缺其他候選人與重複欄位，不再填滿群聊答案',()=>{
  const sources=normalizeSources([{url:'https://example.com/survey',title:'台北調查',content:'甲46.8%，乙46.1%。抽樣誤差±3.1%。'}]);
  const result=renderFactCheck({points:[
    {text:'甲46.8%，乙46.1%。',source_ids:['S1'],evidence_quote:'甲46.8%，乙46.1%。'},
    {text:'抽樣誤差為±3.1%。',source_ids:['S1'],evidence_quote:'抽樣誤差±3.1%。'},
    {text:'未提及其他候選人。',source_ids:['S1']}],caveats:'未提及其他候選人支持度，無法判斷整體選情格局。'},sources,Date.now(),{claim:'台北選舉民調'});
  assert.match(result,/46.8%/);
  assert.ok(!/未提及其他|抽樣誤差為|調查單位：|未提供/u.test(result));
});
