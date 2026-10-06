import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import {weatherRequest} from '../src/weather.js';
import {lookupMemoryQuestion} from '../src/core.js';

globalThis.crypto ||= webcrypto;

async function deliver({ text, sequence, modelResponses, weatherResults, mentions, enabled = true, exhausted = false, searchExhausted = false, tavilyKey, modelResponse, searchResults = [], pollDomains='example.com', historyRows, botTurns = [], excluded = false, clearMemoryDuringGeneration = false, profileNames={} }) {
  const calls = [], replies = [], queries = [], pending = [], searches = [], weatherCalls=[];
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sqlite.prepare('INSERT INTO groups(group_id,enabled) VALUES (?,?)').run('group',enabled ? 1 : 0);
  if (excluded) sqlite.prepare('INSERT INTO members(group_id,user_id,excluded) VALUES (?,?,1)').run('group','asker');
  const now = Math.floor(Date.now()/1000);
  for (const row of historyRows || [{message_id:'history',user_id:'private-id',ts:now,text:'主張應以公開資料及法條核對，不應只看立場。'}]) {
    sqlite.prepare('INSERT INTO messages(message_id,group_id,user_id,ts,text) VALUES (?,?,?,?,?)')
      .run(row.message_id,'group',row.user_id,row.ts < 1000 ? now - 1000 + row.ts : row.ts,row.text);
  }
  for (const [i,turn] of botTurns.entries()) {
    sqlite.prepare('INSERT INTO bot_turns(message_id,group_id,user_id,ts,question,answer) VALUES (?,?,?,?,?,?)')
      .run(turn.message_id || `turn${i}`,turn.group_id || 'group',turn.user_id || 'asker',turn.ts || now,turn.question,turn.answer);
  }
  const db = { prepare(sql) {
    let args;
    return {
      bind(...values) { args = values; return this; },
      async run() { queries.push({ sql, args }); return { meta: { changes: (sql.includes("analysis_usage") && exhausted) || (sql.includes("search_usage") && searchExhausted) ? 0 : sqlite.prepare(sql).run(...(args || [])).changes } }; },
      async first() { queries.push({sql,args}); return sqlite.prepare(sql).get(...(args || [])); },
      async all() { queries.push({sql,args}); return {results:sqlite.prepare(sql).all(...(args || []))}; },
    };
  }, async batch(statements) { return Promise.all(statements.map(s => s.run())); } };
  const env = {
    DB: db, LINE_CHANNEL_SECRET: "test-secret", LINE_CHANNEL_ACCESS_TOKEN: "test-token",
    TAVILY_API_KEY: tavilyKey, POLL_SOURCE_DOMAINS:pollDomains,
    AI: { async run(model, input) { calls.push(input); if(clearMemoryDuringGeneration) sqlite.exec('DELETE FROM bot_turns'); return { response: modelResponses?.[calls.length-1] || modelResponse || "先核對資料與法條，再討論各方提出的理由。" }; } },
  };
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.LINE_CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('open-meteo.com')) {
      weatherCalls.push(String(url));
      return Response.json(weatherResults?.[weatherCalls.length-1] || {});
    }
    if (url === "https://api.tavily.com/search") {
      searches.push(JSON.parse(options.body));
      return Response.json({ results: searchResults });
    }
    if (url.includes('/member/')) return Response.json({displayName:profileNames[String(url).split('/').at(-1)] || '測試成員'});
    replies.push(JSON.parse(options.body).messages[0].text); return new Response("ok");
  };
  try {
    for(const [index,nextText] of (sequence || [text]).entries()) {
      const body=JSON.stringify({destination:'bot',events:[{webhookEventId:`event${index}`,type:'message',timestamp:Date.now(),replyToken:'reply',
        source:{type:'group',groupId:'group',userId:'asker'},message:{type:'text',id:sequence?`request-${index}`:'request',text:nextText,mention:{mentionees:mentions||[]}}}]});
      const sig=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body)))));
      const response = await worker.fetch(new Request("https://bot.test/webhook", { method: "POST", headers: { "x-line-signature": sig }, body }), env, { waitUntil(p) { pending.push(p); } });
      await Promise.all(pending);
      assert.equal(response.status, 200);
    }
    return { calls, replies, queries, searches, weatherCalls, savedTurns:sqlite.prepare('SELECT * FROM bot_turns').all() };
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
}

test('同一位成員接自己丟的船梗，不引用別群、別人或過期問答',async()=>{
  const result=await deliver({text:'/AI 最後一班船是去哪',botTurns:[
    {question:'妳自己下船吧',answer:'我偏要坐到最後一班船！'},
    {user_id:'other',question:'秘密問題',answer:'別人的答案'},
    {group_id:'other-group',question:'另一群問題',answer:'另一群答案'},
    {ts:Math.floor(Date.now()/1000)-3601,question:'昨天問題',answer:'過期答案'},
  ],modelResponse:'去嘴砲碼頭啦，你要不要一起上船 😂'});
  const input=JSON.parse(result.calls[0].messages[1].content.replace(/\n\/no_think$/,''));
  assert.deepEqual(input.recent_bot_turns,[{question:'妳自己下船吧',answer:'我偏要坐到最後一班船！'}]);
  assert.match(result.replies[0],/嘴砲碼頭/);
  const saved=result.savedTurns.find(t=>t.message_id==='request');
  assert.equal(saved.answer,result.replies[0]);
  assert.ok(!JSON.stringify(input).includes('asker'));
});

test('換成指定人物打氣時，不套用之前自己講的故事',async()=>{
  const result=await deliver({text:'/AI 幫成員甲加油打氣一下',botTurns:[{question:'為什麼成員乙加班',answer:'加班真累'}]});
  const input=JSON.parse(result.calls[0].messages[1].content.replace(/\n\/no_think$/,''));
  assert.deepEqual(input.recent_bot_turns,[]);
});

test('使用者實際 AIC 展示要求不帶舊船梗，直接使用類比 IC 提示詞',async()=>{
  const result=await deliver({text:'@AI 讓成員甲跟成員丙見識一下你AIC的實力',mentions:[{type:'user',isSelf:true,index:0,length:3}],
    botTurns:[{question:'最後一班船是去哪',answer:'去嘴砲碼頭啦'}],
    historyRows:[{message_id:'old',user_id:'other',ts:1,text:'AIC 還在碼頭裝貨'}],
    modelResponse:'成員甲、成員丙，理想反相放大器的增益是 −Rf/Rin。'});
  const input=JSON.parse(result.calls[0].messages[1].content.replace(/\n\/no_think$/,''));
  assert.equal(input.reply_intent,'demonstration');
  assert.equal(input.topic_hint,'engineering');
  assert.equal(input.term_definitions.AIC,'類比 IC（Analog IC）');
  assert.equal(input.recent_discussion,'');
  assert.deepEqual(input.recent_bot_turns,[]);
  assert.ok(!result.calls[0].messages[1].content.includes('碼頭'));
  assert.match(result.calls[0].messages[0].content,/提供電機、數位 IC、類比 IC 技術協助/);
  assert.match(result.replies[0],/−Rf\/Rin/);
});

test('明確新工程問題不挾帶舊問答，但真正追問可以承接',async()=>{
  const turns=[{question:'退群',answer:'我還在船上'}];
  const fresh=await deliver({text:'/AI op amp 的輸出擺幅怎麼看',botTurns:turns});
  assert.deepEqual(JSON.parse(fresh.calls[0].messages[1].content.replace(/\n\/no_think$/,'')).recent_bot_turns,[]);
  const followup=await deliver({text:'/AI 剛剛那個再說清楚一點',botTurns:turns});
  assert.equal(JSON.parse(followup.calls[0].messages[1].content.replace(/\n\/no_think$/,'')).recent_bot_turns.length,1);
});

test('能追問新產生的工程梗，氣氛只取近20分鐘相符原話',async()=>{
  const now=Math.floor(Date.now()/1000);
  const result=await deliver({text:'/AI 那班長是誰',botTurns:[{question:'CDC',answer:'同步器又不是8個bit的班長。'}],historyRows:[
    {message_id:'old',user_id:'p',ts:now-3600,text:'一小時前大家在玩上船梗'},
    {message_id:'recent',user_id:'q',ts:now-30,text:'現在正在討論同步器的班長梗'},
  ]});
  const input=JSON.parse(result.calls[0].messages[1].content.replace(/\n\/no_think$/,''));
  assert.equal(input.recent_bot_turns.length,1);
  assert.match(input.recent_atmosphere,/班長/);
  assert.match(input.recent_atmosphere,/P2/);
  assert.ok(!input.recent_atmosphere.includes('上船'));
});

test('模型若仍用船或證照敷衍 AIC 展示，回覆改為有前提的具體示範',async()=>{
  const result=await deliver({text:'/AI 讓成員甲跟成員丙見識一下你AIC的實力',
    modelResponse:'成員甲？成員丙？我AIC還在碼頭裝載貨物呢，難道不先確認船是不是有證照嗎？😂'});
  assert.ok(!/碼頭|船|證照/u.test(result.replies[0]));
  assert.match(result.replies[0],/線性負回授/);
  assert.match(result.replies[0],/−200 mV/);
});

test('AIC 展示不能只出題，把已算完的結果交給群友',async()=>{
  const result=await deliver({text:'/AI 讓成員甲跟成員丙見識一下你AIC的實力',
    modelResponse:'反相放大器使用10kΩ反饋電阻與1kΩ輸入電阻。請問電壓增益是多少？先自己算一下。'});
  assert.match(result.replies[0],/−10/);
  assert.match(result.replies[0],/−200 mV/);
  assert.ok(!result.replies[0].includes('請問'));
});

test('AIC 基本定義固定為本群類比 IC，不被錯誤模型解釋覆蓋',async()=>{
  const result=await deliver({text:'/AI 你知道什麼是AIC嗎',modelResponse:'AIC 是人工智慧芯片（Artificial Intelligence Chip）啦'});
  assert.match(result.replies[0],/AIC/);
  assert.match(result.replies[0],/類比 IC/);
  assert.ok(!result.replies[0].includes('Artificial Intelligence Chip'));
});

test('收到是類比IC的更正時，接受群組用語，不帶入舊錯答或爭辯',async()=>{
  const result=await deliver({text:'/AI 是類比IC',botTurns:[{question:'什麼是AIC',answer:'人工智慧芯片'}],
    modelResponse:'目前並沒有標準定義的AIC指稱類比IC'});
  const input=JSON.parse(result.calls[0].messages[1].content.replace(/\n\/no_think$/,''));
  assert.equal(input.reply_intent,'term_correction');
  assert.deepEqual(input.recent_bot_turns,[]);
  assert.match(result.replies[0],/類比 IC（Analog IC）/);
  assert.ok(!result.replies[0].includes('沒有標準'));
});

test('連續重問 AIC 再抱怨重複，參考真實上一輪並改寫，不覆蓋正確自然回答',async()=>{
  const first='知道啊，AIC 就是類比 IC，電壓參考和運放都是典型例子。';
  const result=await deliver({sequence:['/AI 你知道什麼是AIC嗎','/AI 你知道什麼是AIC嗎','/AI 你怎麼一直重複一樣的內容?'],
    modelResponses:[first,first,'幹，我這是在練習「重複」這項專業技能，要不要加點變化？']});
  assert.equal(result.replies[0],first);
  assert.notEqual(result.replies[1],first);
  assert.match(result.replies[1],/類比 IC/);
  assert.match(result.replies[2],/算我的|照貼/);
  assert.match(result.replies[2],/放大|感測器|濾波/);
  assert.ok(!result.replies[2].includes('專業技能'));
  const repeat=JSON.parse(result.calls[1].messages[1].content.replace(/\n\/no_think$/,''));
  assert.equal(repeat.repeated_question_count,1);
  assert.equal(repeat.recent_bot_turns[0].answer,first);
  const feedback=JSON.parse(result.calls[2].messages[1].content.replace(/\n\/no_think$/,''));
  assert.equal(feedback.reply_intent,'response_feedback');
  assert.equal(feedback.recent_bot_turns.length,2);
  assert.equal(feedback.topic_hint,'engineering');
});

test('重問定義可保留有新內容的模型回答，不強制變成保底整句',async()=>{
  const answer='AIC 是類比 IC。拿感測器訊號為例，前端可先做放大和濾波，再送給後續電路。';
  const result=await deliver({text:'/AI AIC是什麼',botTurns:[{question:'你知道什麼是AIC嗎',answer:'AIC是類比 IC，像LDO。'}],modelResponse:answer});
  assert.equal(result.replies[0],answer);
});

test('民調追問承接來源；查阿及抱怨懶惰重查原主題，少講髒話立即生效',async()=>{
  const poll=JSON.stringify({verdict:'supported',points:[{text:'甲支持度46.8%，乙46.1%。',source_ids:['S1'],evidence_quote:'甲支持度46.8%，乙46.1%。'},{text:'差距在誤差範圍內，幾乎五五波。',source_ids:['S1']}],caveats:'調查資訊不完整'});
  const result=await deliver({sequence:['/AI 查證台北選舉民調','/AI 所以甲會贏？','/AI 你查阿不要只會靠杯','/AI 有夠懶','/AI 不要整天只會幹幹叫','/AI AIC是什麼'],tavilyKey:'test-key',
    searchResults:[{url:'https://example.com/survey',title:'台北市調查',published_date:new Date().toISOString(),content:'甲支持度46.8%，乙46.1%。'}],
    modelResponses:[poll,'幹，你這問題跟太陽會不會升起一樣無聊，還不快去查民調？',poll,poll,'幹，AIC 是類比 IC。']});
  assert.match(result.replies[0],/調查日期或方法沒附完整/);
  assert.ok(!result.replies[0].includes('判斷：目前資料支持'));
  assert.ok(!result.replies[0].includes('差距在誤差範圍內'));
  const input=JSON.parse(result.calls[1].messages[1].content.replace(/\n\/no_think$/,''));
  assert.equal(input.reply_intent,'poll_followup');
  assert.ok(input.recent_bot_turns[0].answer.includes('台北市調查'));
  assert.match(result.replies[1],/不能這樣推/);
  assert.ok(!/無聊|快去查/.test(result.replies[1]));
  assert.equal(result.searches.length,3);
  assert.ok(result.searches.every(search=>search.query.includes('台北選舉民調')));
  assert.ok(result.searches.every(search=>!search.query.includes('靠杯')&&!JSON.stringify(search).includes('先前')));
  assert.match(result.replies[4],/嘴過頭|少講髒話/);
  assert.ok(!/幹|靠北/.test(result.replies[4]));
  assert.equal(result.calls.length,5);
  const next=JSON.parse(result.calls[4].messages[1].content.replace(/\n\/no_think$/,''));
  assert.equal(next.tone_mode,'restrained');
  assert.ok(!result.replies[5].includes('幹'));
});

test('省略主題的搜尋只沿用同群同人未過期問答，不把其他人的話送搜尋',async()=>{
  for(const turn of [{user_id:'other'},{group_id:'other-group'},{ts:Math.floor(Date.now()/1000)-3601}]) {
    const result=await deliver({text:'/AI 你查啊不要只會靠杯',tavilyKey:'test-key',botTurns:[{...turn,question:'查證秘密內容',answer:'秘密答案'}]});
    assert.equal(result.searches.length,0);
    assert.equal(result.calls.length,0);
    assert.ok(!result.replies[0].includes('秘密'));
    assert.match(result.replies[0],/請給主題/);
  }
});

test('本日民調、未加查證的民調與人物更正皆走搜尋，不靠舊模型記憶',async()=>{
  const result=await deliver({sequence:['/AI 台北市市長選舉本日民調','/AI 台北市市長選舉民調','/AI 現在是甲與乙'],tavilyKey:'test-key',
    searchResults:[{url:'https://example.com/current',published_date:new Date().toISOString(),title:'台北公開調查',content:'甲支持度46.8%，乙46.1%。'},{url:'https://example.com/old',published_date:'2022-09-01',title:'舊選舉',content:'舊人物的資料'}],
    modelResponse:JSON.stringify({verdict:'supported',points:[{text:'甲支持度46.8%，乙46.1%。',source_ids:['S1']}],caveats:'未提供調查方法'})});
  assert.equal(result.searches.length,3);
  assert.equal(result.searches[0].topic,'general');
  assert.equal(result.searches[0].country,'taiwan');
  assert.equal(result.searches[0].time_range,'day');
  assert.equal(result.searches[1].time_range,'month');
  assert.equal(result.searches[0].filter_by_published_date,true);
  assert.match(result.searches[2].query,/台北市長選舉民調 核對更正：甲與乙/);
  assert.ok(result.calls.every(call=>!call.messages[1].content.includes('舊人物')));
  assert.ok(result.calls.every(call=>call.messages[0].content.includes('只用來源片段')));
  assert.ok(!result.replies.join('').includes('昨天才剛出'));
});

test('本日查詢只有昨天或缺日期的來源時，明說不能確認而不呼叫模型補舊人名',async()=>{
  const result=await deliver({text:'/AI 台北市市長選舉本日民調',tavilyKey:'test-key',
    searchResults:[{url:'https://example.com/undated',title:'沒有日期',content:'一些人名'},{url:'https://example.com/yesterday',published_date:new Date(Date.now()-86400000).toISOString(),title:'昨天資料',content:'昨天的數字'}],
    modelResponse:'昨天才剛有民調，舊人物支持度40%。'});
  assert.equal(result.searches.length,1);
  assert.equal(result.calls.length,0);
  assert.match(result.replies[0],/未找到能確認本日日期/);
  assert.ok(!result.replies[0].includes('40%'));
});

test('台北市新聞不反問使用者，直接查相關近期來源並短句整理',async()=>{
  const result=await deliver({text:'/AI 台北市新聞',tavilyKey:'test-key',searchResults:[
    {url:'https://example.com/local',title:'台北市道路施工公告',published_date:new Date().toISOString(),content:'台北市道路施工，請注意改道。'},
    {url:'https://example.com/foreign',title:'以色列選舉',published_date:new Date().toISOString(),content:'Likud poll'},
  ],modelResponse:JSON.stringify({points:[{text:'台北市有道路施工，出門注意改道。',source_ids:['S1'],evidence_quote:'台北市道路施工，請注意改道。'}],caveats:''})});
  assert.equal(result.searches.length,1);
  assert.equal(result.searches[0].country,'taiwan');
  assert.equal(result.searches[0].language,'zh');
  assert.equal(result.searches[0].search_depth,'basic');
  assert.equal(result.searches[0].time_range,'week');
  assert.ok(!result.calls[0].messages[1].content.includes('Likud'));
  assert.match(result.replies[0],/道路施工/);
  assert.ok(!result.replies[0].includes('有什麼特別'));
});

test('現在是兩人誰會贏承接民調，不誤判更正、不重搜且保留自然比喻',async()=>{
  const result=await deliver({text:'/AI 現在是成員丁跟成員丙誰會贏?',tavilyKey:'test-key',
    botTurns:[{question:lookupMemoryQuestion('查證台北選舉民調','台北選舉民調'),answer:'🔎 民調資料整理｜找到的是評論轉述，調查日期或方法沒附完整。'}],
    modelResponse:'光看前面那篇評論還判不了誰會贏，民調不是開票機。先拿到原始調查再談贏面，別把聲量當選票。'});
  assert.equal(result.searches.length,0);
  assert.equal(result.calls.length,1);
  const input=JSON.parse(result.calls[0].messages[1].content.replace(/\n\/no_think$/,''));
  assert.equal(input.reply_intent,'poll_followup');
  assert.equal(input.tone_mode,'contextual');
  assert.match(result.replies[0],/民調不是開票機/);
  assert.ok(!/調查單位：|樣本：|來源（/u.test(result.replies[0]));
});

test('實際模型用整份抽樣誤差斷言旗鼓相當時，改回貼題且無確定勝負的短句',async()=>{
  const result=await deliver({text:'/AI 現在是甲跟乙誰會贏?',botTurns:[{question:lookupMemoryQuestion('台北選舉民調','台北選舉民調'),answer:'🔎 民調資料整理｜甲46.8%、乙46.1%，抽樣誤差±3.1%。'}],
    modelResponse:'兩人差0.7個百分點，不過誤差±3.1%，這差距還算接近，目前旗鼓相當。'});
  assert.match(result.replies[0],/民調不是開票機/);
  assert.ok(!/旗鼓相當|目前|±3.1/u.test(result.replies[0]));
});

test('只有不相關的國外民調時不呼叫模型，也不列出無關網址',async()=>{
  const result=await deliver({text:'/AI 台北市市長選舉民調',tavilyKey:'test-key',searchResults:[
    {url:'https://example.com/israel',title:'Israeli election polls',content:'Likud and Yashar',published_date:new Date().toISOString()},
  ]});
  assert.equal(result.searches.length,1);
  assert.equal(result.calls.length,0);
  assert.ok(!result.replies[0].includes('example.com'));
});

test('使用者最新回報：舊以色列民調與其追問不再污染新版，重查台北一次再自然承接',async()=>{
  const now=Math.floor(Date.now()/1000);
  const result=await deliver({sequence:['/AI 現在是成員丁跟成員丙誰會贏?','/AI 所以誰會贏？','/AI 所以這份怎麼看？'],tavilyKey:'test-key',botTurns:[
    {ts:now-10,question:'現在是成員丁跟成員丙誰會贏?',answer:'這份判不了誰會贏，資料全跟以色列2026選舉有關，這調查是來錯場了啦。'},
    {ts:now-20,question:'現在是成員丁跟成員丙誰會贏?\n查詢主題：台北選舉民調 核對更正：成員丁跟成員丙誰會贏?',answer:'🔎 民調資料整理｜全部是以色列選舉。https://example.com/israel'},
  ],searchResults:[{url:'https://example.com/taipei',title:'台北市選情調查',content:'甲支持度46.8%，乙46.1%。',published_date:new Date().toISOString()}],
    modelResponses:[JSON.stringify({points:[{text:'甲46.8%，乙46.1%。',source_ids:['S1'],evidence_quote:'甲支持度46.8%，乙46.1%。'}]}),'這份調查判不了誰會贏，民調不是開票機。','這份調查還缺日期和方法，先別把它當全市戰況。']});
  assert.equal(result.searches.length,1);
  assert.match(result.searches[0].query,/台北選舉民調/);
  assert.ok(!/以色列|核對更正|israel/u.test(JSON.stringify(result.searches)));
  assert.match(result.replies[0],/查錯場，算我的/);
  assert.match(result.replies[0],/46.8%/);
  assert.ok(!/以色列|israel/u.test(JSON.stringify(result.calls)));
  assert.match(result.replies[1],/民調不是開票機/);
  assert.equal(JSON.parse(result.calls[2].messages[1].content.replace(/\n\/no_think$/,'')).reply_intent,'poll_followup');
  const latest=result.savedTurns.find(t=>t.message_id==='request-2');
  assert.match(latest.question,/查詢主題：台北選舉民調/);
  assert.match(latest.question,/查詢版本：sourced-v2/);
});

test('舊民調沒有明顯污染字樣，新版首次追問也重新核對',async()=>{
  const result=await deliver({text:'/AI 那這份民調怎麼看？',tavilyKey:'test-key',botTurns:[{question:'查證台北選舉民調',answer:'🔎 民調資料整理｜甲40%，乙39%，未提供日期。'}],
    searchResults:[{url:'https://example.com/taipei',title:'台北公開資料',content:'尚無可核對調查。',published_date:new Date().toISOString()}],modelResponse:JSON.stringify({points:[{text:'片段尚無可核對調查。',source_ids:['S1'],evidence_quote:'尚無可核對調查。'}]})});
  assert.equal(result.searches.length,1);
  assert.ok(!JSON.stringify(result.calls).includes('甲40%'));
  assert.match(result.replies[0],/重新核對/);
});

test('重新核對期間舊查詢被刪除，不回傳也不存新查證記憶',async()=>{
  const result=await deliver({text:'/AI 所以誰會贏？',tavilyKey:'test-key',botTurns:[{question:'查證台北選舉民調',answer:'🔎 民調資料整理｜以色列選舉。'}],clearMemoryDuringGeneration:true,
    searchResults:[{url:'https://example.com/taipei',title:'台北公開資料',content:'尚無可核對調查。',published_date:new Date().toISOString()}],modelResponse:JSON.stringify({points:[{text:'尚無調查',source_ids:['S1']}]})});
  assert.match(result.replies[0],/記錄已清除/);
  assert.deepEqual(result.savedTurns,[]);
});

test('台灣民調搜尋限制具名來源；網易自媒體與偽裝子網域不交給模型',async()=>{
  const result=await deliver({text:'/AI 查證台北選舉民調',tavilyKey:'test-key',pollDomains:'',searchResults:[
    {url:'https://www.163.com/dy/article/fake.html',title:'台北最新民調驚人',content:'甲支持度99%。',published_date:new Date().toISOString()},
    {url:'https://cna.com.tw.evil.example/fake',title:'台北市民調',content:'乙支持度98%。',published_date:new Date().toISOString()},
    {url:'https://www.cna.com.tw/news/test',title:'台北市調查',content:'甲支持度46.8%，乙46.1%。',published_date:new Date().toISOString()},
  ],modelResponse:JSON.stringify({points:[{text:'甲46.8%，乙46.1%。',source_ids:['S1'],evidence_quote:'甲支持度46.8%，乙46.1%。'}]})});
  assert.equal(result.searches[0].include_domains_mode,'restrict');
  assert.ok(result.searches[0].include_domains.includes('cna.com.tw'));
  assert.equal(result.searches[0].max_results,8);
  assert.equal(result.searches[0].chunks_per_source,3);
  assert.equal(result.searches[0].filter_by_language,false);
  assert.ok(!result.searches[0].query.includes('調查日期 樣本'));
  assert.ok(!/163.com|evil.example|99%|98%/u.test(JSON.stringify(result.calls)));
  assert.match(result.replies[0],/46.8%/);
});

test('只有自媒體結果時不呼叫模型、不把該頁當民調來源',async()=>{
  const result=await deliver({text:'/AI 台北市市長選舉民調',tavilyKey:'test-key',pollDomains:'',searchResults:[
    {url:'https://www.163.com/dy/article/fake.html',title:'台北最新民調驚人',content:'甲支持度99%。',published_date:new Date().toISOString()},
  ]});
  assert.equal(result.calls.length,0);
  assert.ok(!result.replies[0].includes('163.com'));
});

test('前版地區篩選記憶也要重查，不能沿用先前通過的網易資料',async()=>{
  const result=await deliver({text:'/AI 所以谁會贏？'.replace('谁','誰'),tavilyKey:'test-key',pollDomains:'',botTurns:[
    {question:'查證台北選舉民調\n查詢主題：台北選舉民調\n查詢版本：regional-v1',answer:'🔎 民調資料整理｜來源是網易。https://www.163.com/dy/test'},
  ],searchResults:[{url:'https://www.cna.com.tw/news/test',title:'台北市調查',content:'甲支持度46.8%，乙46.1%。',published_date:new Date().toISOString()}],modelResponse:JSON.stringify({points:[{text:'甲46.8%，乙46.1%。',source_ids:['S1'],evidence_quote:'甲支持度46.8%，乙46.1%。'}]})});
  assert.equal(result.searches.length,1);
  assert.ok(!JSON.stringify(result.calls).includes('163.com'));
  assert.match(result.savedTurns.find(t=>t.message_id==='request').question,/sourced-v2/);
});

test('互嘴保留玩笑路由，新題後抱怨懶惰不重查舊主題',async()=>{
  const joke=await deliver({text:'/AI 你很屌',botTurns:[{question:'你給我自動退群',answer:'我還沒領便當欸'}],modelResponse:'現在才發現？你這偵測延遲有點高欸。'});
  const input=JSON.parse(joke.calls[0].messages[1].content.replace(/\n\/no_think$/,''));
  assert.equal(input.reply_intent,'banter');
  assert.equal(input.tone_mode,'contextual');
  assert.equal(input.recent_bot_turns[0].answer,'我還沒領便當欸');
  assert.match(joke.replies[0],/偵測延遲/);
  const changed=await deliver({text:'/AI 有夠懶',tavilyKey:'test-key',botTurns:[{question:'你給我自動退群',answer:'玩笑回嘴'},{ts:Math.floor(Date.now()/1000)-30,question:'查證先前的事件',answer:'前次資料'}],modelResponse:'我還沒領便當，哪能現在下班啦。'});
  assert.equal(changed.searches.length,0);
  assert.equal(changed.calls.length,1);
});

test('省略主題搜尋生成期間原記憶被刪除，不回傳或補存結果',async()=>{
  const result=await deliver({text:'/AI 你查啊',tavilyKey:'test-key',botTurns:[{question:'查證某產品已上市',answer:'前次片段'}],clearMemoryDuringGeneration:true,
    searchResults:[{url:'https://example.com/report',title:'公告',content:'產品已上市'}],modelResponse:JSON.stringify({verdict:'supported',points:[{text:'產品已上市',source_ids:['S1']}]})});
  assert.match(result.replies[0],/記錄已清除/);
  assert.deepEqual(result.savedTurns,[]);
});

test('只更換粗口的近似重複不能過關，收到糾正不再反嗆提問者',async()=>{
  const content='AIC 就是類比 IC，也就是處理類比訊號的積體電路。像運算放大器、電壓調整器、感測器介面之類的，都是 AIC 的範疇。簡單說，就是直接處理連續變化的電壓或電流的晶片。';
  const result=await deliver({sequence:['/AI 你知道什麼是AIC嗎','/AI 你知道什麼是AIC嗎','/AI 你怎麼一直重複一樣的內容?'],
    modelResponses:[content+'靠北，這還用問？',content+'笑死，這還用問？','對，我剛剛重複了。AIC 是類比 IC，像運算放大器。幹，這還用問？你是不是剛入行啊？']});
  assert.equal(result.replies[0],content);
  assert.match(result.replies[1],/微弱訊號/);
  assert.ok(!result.replies[1].includes('這還用問'));
  assert.match(result.replies[2],/算我的|照貼/);
  assert.ok(!/這還用問|剛入行/.test(result.replies[2]));
});

test('查證明天天氣先問城市，不搜無關網頁也不消耗 AI',async()=>{
  const result=await deliver({text:'@AI 查證明天天氣',mentions:[{type:'user',isSelf:true,index:0,length:3}],tavilyKey:'test-key'});
  assert.match(result.replies[0],/哪個城市/);
  assert.equal(result.calls.length,0);
  assert.equal(result.searches.length,0);
  assert.equal(result.weatherCalls.length,0);
  assert.ok(!result.queries.some(q=>q.sql.includes('INSERT INTO analysis_usage')));
});

test('有城市的明天天氣直接查免費預報，核對日期單位並附來源',async()=>{
  const date=weatherRequest('台北明天天氣').date;
  const result=await deliver({text:'/查證 台北明天天氣',weatherResults:[
    {results:[{name:'台北市',latitude:25.05,longitude:121.53,country_code:'TW',feature_code:'PPLC'}]},
    {daily:{time:[date],weather_code:[61],temperature_2m_min:[24],temperature_2m_max:[29],precipitation_probability_max:[70]},
      daily_units:{temperature_2m_min:'°C',temperature_2m_max:'°C',precipitation_probability_max:'%'}},
  ]});
  assert.equal(result.calls.length,0);
  assert.equal(result.searches.length,0);
  assert.equal(result.weatherCalls.length,2);
  assert.equal(new URL(result.weatherCalls[1]).searchParams.get('start_date'),date);
  assert.match(result.replies[0],/24～29°C/);
  assert.match(result.replies[0],/70%/);
  assert.match(result.replies[0],/Open-Meteo/);
  assert.ok(!result.replies[0].includes('Stadtwerke'));
});

test('預報沒有對應日期時不把別天資料或空值當今明天天氣',async()=>{
  const result=await deliver({text:'/查證 台北明天天氣',weatherResults:[
    {results:[{latitude:25,longitude:121,country_code:'TW',feature_code:'PPLC'}]},
    {daily:{time:['2000-01-01'],temperature_2m_min:[20],temperature_2m_max:[30],precipitation_probability_max:[10]}},
  ]});
  assert.match(result.replies[0],/資料暫時取不到/);
  assert.equal(result.searches.length,0);
});

test('退出統計清除群組問答；排除者仍能提問但不留下問答記憶',async()=>{
  const stopped=await deliver({text:'/退出統計',botTurns:[{question:'剛剛討論',answer:'先前回覆'}]});
  assert.deepEqual(stopped.savedTurns,[]);
  const excluded=await deliver({text:'/AI 你好',excluded:true});
  assert.equal(excluded.calls.length,1);
  assert.deepEqual(excluded.savedTurns,[]);
});

test('生成期間問答記憶被刪除時，不回傳也不重新儲存旧答案',async()=>{
  const result=await deliver({text:'/AI 然後呢',botTurns:[{question:'之前',answer:'已清除內容'}],clearMemoryDuringGeneration:true});
  assert.match(result.replies[0],/記錄已清除/);
  assert.deepEqual(result.savedTurns,[]);
});

test('請你查詢回應我確實走搜尋；查證問答可以供下一輪接話',async()=>{
  const result=await deliver({text:'@AI 請你查詢回應我 某產品是否已正式上市',mentions:[{type:'user',isSelf:true,index:0,length:3}],
    tavilyKey:'test-key',searchResults:[{url:'https://example.com/report',title:'公開報導',content:'辯論邀請與回應需要日期核對'}],
    modelResponse:JSON.stringify({verdict:'insufficient',points:[{text:'須區分是否回應邀請與怯戰的主觀評價',source_ids:['S1']}],caveats:'缺少日期'})});
  assert.equal(result.searches[0].query,'某產品是否已正式上市');
  assert.ok(!JSON.stringify(result.searches[0]).includes('先前'));
  assert.match(result.replies[0],/https:\/\/example.com\/report/);
  assert.equal(result.savedTurns.find(t=>t.message_id==='request').question,lookupMemoryQuestion('請你查詢回應我 某產品是否已正式上市','某產品是否已正式上市'));
});

test('電機、數位與類比題採工程背景並給足回答空間，仍共用免費上限',async()=>{
  for (const question of ['setup 和 hold 怎麼分','op amp 相位裕度不足怎麼查','電源電路的電容怎麼選']) {
    const result=await deliver({text:`/AI ${question}`,historyRows:[
      {message_id:'unrelated',user_id:'p',ts:1,text:'今天討論不同觀點的主張'},
      {message_id:'engineering',user_id:'e',ts:2,text:'先看電路負載與波形'},
    ]});
    const input=JSON.parse(result.calls[0].messages[1].content.replace(/\n\/no_think$/,''));
    assert.equal(input.topic_hint,'engineering');
    assert.ok(!input.recent_discussion.includes('觀點'));
    assert.equal(result.calls[0].max_tokens,1400);
    assert.equal(result.queries.find(q=>q.sql.includes('INSERT INTO analysis_usage')).args[2],300);
  }
});

test('工程查詢優先搜尋原廠文件，而非沿用公開議題官方站點',async()=>{
  const result=await deliver({text:'/AI 請你查詢 ADC 的 datasheet',tavilyKey:'test-key'});
  assert.equal(result.searches.length,1);
  assert.ok(result.searches[0].include_domains.includes('ti.com'));
  assert.ok(!result.searches[0].include_domains.includes('ly.gov.tw'));
});

test("真實 mention webhook 觸發模型，去除 Bot 標註及原始 ID", async () => {
  const result = await deliver({ text: "@AI 幫我分析雙方論點", mentions: [{ type: "user", isSelf: true, index: 0, length: 3 }] });
  assert.equal(result.calls.length, 1);
  const input = JSON.parse(result.calls[0].messages[1].content.replace(/\n\/no_think$/, ""));
  assert.equal(input.question, "幫我分析雙方論點");
  assert.ok(!input.recent_discussion.includes("private-id"));
  assert.equal(result.replies[0], "先核對資料與法條，再討論各方提出的理由。");
  assert.equal(result.queries.find(q => q.sql.includes("analysis_usage")).args[2], 300);
});

test("一般聊天、標註別人、@all 不消耗 AI", async () => {
  for (const mentions of [[], [{ type: "user", userId: "other", index: 0, length: 3 }], [{ type: "all", index: 0, length: 3 }]]) {
    assert.equal((await deliver({ text: "@某人 這個論點如何", mentions })).calls.length, 0);
  }
});

test("提問換人時模型只收到對應人物背景，不能承襲別人的加班", async () => {
  const result=await deliver({text:'/AI 幫成員甲加油打氣一下',historyRows:[
    {message_id:'m1',user_id:'other',ts:1,text:'成員乙還在加班。'},
    {message_id:'m2',user_id:'other',ts:2,text:'@AI群聊助手 幫成員甲加油打氣一下'},
  ]});
  const input=JSON.parse(result.calls[0].messages[1].content.replace(/\n\/no_think$/,''));
  assert.equal(input.target_name,'成員甲');
  assert.equal(input.reply_intent,'encouragement');
  assert.equal(input.recent_discussion,'');
});

test("只有重複問候的戰力請求不評成零分，也不消耗 AI 額度", async () => {
  const result=await deliver({text:'/戰力',historyRows:[1,2,3,4].map(i=>({message_id:`m${i}`,user_id:'person',ts:i,text:'@AI群聊助手 你好'}))});
  assert.equal(result.calls.length,0);
  assert.ok(!result.queries.some(q=>q.sql.includes('INSERT INTO analysis_usage')));
  assert.match(result.replies[0],/還沒有足夠的實質討論/);
  assert.ok(!result.replies[0].includes('0/100'));
});

test("戰力預設查近七天，本月查近三十天；長期資料可產生排名", async () => {
  for (const [command,days] of [['/戰力',7],['/本月戰力',30]]) {
    const result=await deliver({text:command,historyRows:[1,2,3].map(i=>({message_id:`m${i}`,user_id:'person',ts:i,text:`第${i}項理由：討論應該附上原始資料，而不是單看立場。`})),modelResponse:JSON.stringify({participants:[{id:'P1',clarity:20,responsiveness:10,evidence:5,logic:10,interaction:5,evidence_ids:['m1'],reason:'提出核對資料的方法'}]})});
    const query=result.queries.find(q=>q.sql.includes('ORDER BY ts DESC') && q.sql.includes('LIMIT 10000'));
    assert.ok(Math.abs(query.args[1]-(Math.floor(Date.now()/1000)-days*86400))<3);
    assert.equal(result.calls[0].max_tokens,2400);
    assert.match(result.replies[0],/採樣 3 則、1 人；1 人取得可核對評分/);
    assert.match(result.replies[0],/50\/100/);
  }
});

test("停用群組或額度耗盡時不呼叫模型；/AI 可替代標註", async () => {
  assert.equal((await deliver({ text: "/AI 問題", enabled: false })).calls.length, 0);
  const capped = await deliver({ text: "/AI 問題", exhausted: true });
  assert.equal(capped.calls.length, 0);
  assert.match(capped.replies[0], /300/);
  assert.equal((await deliver({ text: "/AI 問題" })).calls.length, 1);
});

test("查證缺少金鑰或搜尋額度耗盡時，不假装已查證", async () => {
  const missing = await deliver({ text: "/查證 最新預算" });
  assert.equal(missing.calls.length, 0);
  assert.match(missing.replies[0], /尚未設定/);
  const capped = await deliver({ text: "/查證 最新預算", tavilyKey: "test-key", searchExhausted: true });
  assert.equal(capped.searches.length, 0);
  assert.match(capped.replies[0], /搜尋上限/);
});

test("標註查證先搜尋說法再生成附來源結果，不傳群組歷史", async () => {
  const result = await deliver({ text: "@AI 查證 最新預算", mentions: [{ type: "user", isSelf: true, index: 0, length: 3 }],
    tavilyKey: "test-key", searchResults: [{ url: "https://example.com/source", title: "公開資料", content: "尚未完成" }],
    modelResponse: JSON.stringify({ verdict: "mixed", points: [{ text: "尚需確認條件", source_ids: ["S1"] }], caveats: "只有片段" }) });
  assert.equal(result.searches.length, 1);
  assert.equal(result.searches[0].query, "最新預算");
  assert.equal(result.searches[0].search_depth, "basic");
  assert.ok(!JSON.stringify(result.searches[0]).includes("公開資料及法條"));
  assert.match(result.replies[0], /https:\/\/example.com\/source/);
});

test('人物提問依群組作者標籤取背景，不把其他公開議題原話套上身',async()=>{
 const result=await deliver({text:'/AI 成員甲在幹嘛？我看不懂',profileNames:{memberA:'成員甲',memberB:'成員乙'},historyRows:[{message_id:'a',user_id:'memberA',ts:1,text:'我又轉貼了一次活動名單。'},{message_id:'b',user_id:'memberB',ts:2,text:'候選人最近在拉票。'}],modelResponse:'P1是重貼活動名單。'});
 const input=JSON.parse(result.calls[0].messages[1].content.replace(/\n\/no_think$/,''));assert.equal(input.target_kind,'group_member');assert.match(input.recent_discussion,/活動名單/);assert.ok(!input.recent_discussion.includes('拉票'));
 assert.equal(result.replies[0],'成員甲是重貼活動名單。');assert.ok(!JSON.stringify(input).includes('memberA'));
});

test('來源、支持谁、闭嘴及戰力機制走確定功能答覆，不浪費模型或沿用錯誤公開議題故事',async()=>{
 for(const question of ['你從哪來的','候選甲跟候選乙你支持誰？','閉嘴','為什麼一直說話但是戰力沒有提升？']){
 const result=await deliver({text:'/AI '+question,botTurns:[{question:'誰在忙？',answer:'他是候選人，在幫忙拉票。'}]});assert.equal(result.calls.length,0);assert.ok(!result.queries.some(q=>q.sql.includes('INSERT INTO analysis_usage')));assert.ok(!result.replies[0].includes('他是候選人'));}
});

test('懶人包傳入受話對象，Bot被嘴不會顯示為群友互吵',async()=>{
 const result=await deliver({text:'/懶人包',historyRows:[{message_id:'a',user_id:'person',ts:1,text:'@AI 你是不是又接錯話了'},{message_id:'b',user_id:'person',ts:2,text:'這群是吃早餐用的'}],modelResponse:JSON.stringify({events:[{text:'P1質疑Bot接錯話。',actors:['P1'],recipient:'BOT',source_ids:['m1']},{text:'P1說這群是吃早餐用的。',actors:['P1'],recipient:'GROUP',source_ids:['m2']}],quotes:[]})});
 const input=JSON.parse(result.calls[0].messages[1].content.replace(/\n\/no_think$/,''));assert.equal(input.messages[0].recipient,'BOT');assert.equal(input.messages[1].recipient,'GROUP');assert.match(result.replies[0],/與 Bot 互動/);assert.ok(!/交鋒點|尚無結論處/u.test(result.replies[0]));
});

test('戰力只評到一人時明列未完成的其他人，不把採樣人数當完整排名',async()=>{
 const rows=['a','b'].flatMap(id=>[1,2,3].map(i=>({message_id:id+i,user_id:id,ts:i,text:id+'第'+i+'個理由：應該先核對原始資料再討論。'})));
 const result=await deliver({text:'/戰力',historyRows:rows,profileNames:{a:'成員甲',b:'成員乙'},modelResponse:JSON.stringify({participants:[{id:'P1',clarity:20,responsiveness:10,evidence:5,logic:10,interaction:5,evidence_ids:['m1'],reason:'有提供核對理由'}]})});
 const input=JSON.parse(result.calls[0].messages[1].content.replace(/\n\/no_think$/,''));assert.equal(input.participants.length,2);
 assert.match(result.replies[0],/2 人；1 人取得可核對評分/);assert.match(result.replies[0],/未完成評分：成員乙/);assert.match(result.replies[0],/不代表0分/);
});

test('叫弟弟走AI可加戲，舊背景依時間降權而不固定成一句',async()=>{
 const now=Math.floor(Date.now()/1000);
 const result=await deliver({text:'/AI 叫成員甲一聲弟弟',historyRows:[{message_id:'a',user_id:'person',ts:now-4*3600,text:'洋流艦隊船員轉貼候選人名單。'},{message_id:'b',user_id:'person',ts:now-60,text:'剛點了宵夜。'}],botTurns:[{question:'你在幹嘛',answer:'你是洋流艦隊指揮官，要幫某候選人拉票。'}],modelResponse:'成員甲，弟弟！叫都叫了，宵夜記得分我一份 😎'});
 assert.deepEqual(result.replies,['成員甲，弟弟！叫都叫了，宵夜記得分我一份 😎']);assert.equal(result.calls.length,1);assert.equal(result.searches.length,0);
 const input=JSON.parse(result.calls[0].messages[1].content.replace(/\n\/no_think$/,''));assert.equal(input.reply_intent,'playful_address');assert.equal(input.requested_address,'弟弟');assert.match(input.recent_discussion,/宵夜/);assert.ok(!input.recent_discussion.includes('候選人'));assert.deepEqual(input.recent_bot_turns,[]);
});
