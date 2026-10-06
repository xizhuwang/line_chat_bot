import test from 'node:test';import assert from 'node:assert/strict';
import {conversationalInput,conversationalReply,prepareConversationMemory,directConversationReply,rankingSample,scoreRanking,conversationIssues} from '../src/core.js';
import {summaryEntries,renderSummary} from '../src/analysis.js';

test('人物題以作者名稱找到群友發言，不把群友補成候選人',()=>{
 const rows=[{user_id:'a',message_id:'one',ts:1,text:'我貼了各地候選人的活動名單。'},{user_id:'b',message_id:'two',ts:2,text:'另一個人在加班。'}];
 const input=conversationalInput('成員甲在幹嘛？我看不懂',rows,new Map([['a','成員甲'],['b','成員乙']]));
 assert.equal(input.target_kind,'group_member');assert.match(input.recent_discussion,/活動名單/);assert.ok(!input.recent_discussion.includes('加班'));
 assert.equal(conversationalReply('P1只是轉貼活動名單。',input),'成員甲只是轉貼活動名單。');
 const unknown=conversationalInput('不明人物在幹嘛？',rows);
 assert.equal(unknown.recent_discussion,'');assert.ok(!conversationalReply('他是立委候選人，在各地拉票。',unknown).includes('他是立委候選人'));
});

test('日常回答與連續互嗆不反覆喊粗口，幹嘛和幹活保留',()=>{
 const input=conversationalInput('你知道原因嗎',[]);prepareConversationMemory(input,[]);
 assert.equal(conversationalReply('幹，你是在幹嘛？靠北，我先幹活。',input),'你是在幹嘛？我先幹活。');
 const joke=conversationalInput('你很屌',[]);prepareConversationMemory(joke,[{question:'你很嘴',answer:'幹，我超會嘴。'}]);
 assert.equal(joke.profanity_budget,0);assert.ok(!conversationalReply('幹，靠北，你現在才知道？',joke).includes('靠北'));
});

test('問Bot來源、支持誰、外部行動與閉嘴，不借用公開議題舊梗',()=>{
 for(const q of ['你從哪來的','哪個傻逼訓練你的','where you come from'])assert.match(directConversationReply(q),/Cloudflare.*Qwen/);
 assert.equal(directConversationReply('你是誰拉進群組的'),null);
 assert.match(directConversationReply('候選甲跟候選乙你支持誰？'),/沒有支持名單/);
 assert.match(directConversationReply('幫我打電話給朋友'),/不能打電話/);
 assert.match(directConversationReply('閉嘴'),/先安靜/);
 assert.match(directConversationReply('為什麼一直說話但戰力一直都沒有提升？'),/不是聊天次數/);
});

test('真正承接人肉機縮寫與船員船長選擇，保留同人的近期問答',()=>{
 const input=conversationalInput('人肉投票機的簡稱是什麼',[]);prepareConversationMemory(input,[{question:'打電話？',answer:'別把我當人肉投票機。'}]);
 assert.equal(input.recent_bot_turns.length,1);
 const boat=conversationalInput('你想當船員還是船長',[]);prepareConversationMemory(boat,[{question:'船員還是工程師',answer:'船員啦。'}]);assert.equal(boat.recent_bot_turns.length,1);
});

test('摘要保留對Bot的受話對象，排除錯誤交鋒和虛構金句',()=>{
 const rows=[{user_id:'a',ts:1,text:'@AI群聊助手 你是不是又接錯話了'},{user_id:'b',ts:2,text:'這群是吃早餐用的'}];
 const entries=summaryEntries(rows,new Map([['a','P1'],['b','P2']]));const names=new Map([['P1','成員甲'],['P2','成員乙']]);
 assert.equal(entries[0].recipient,'BOT');
 const result=renderSummary({events:[{text:'P1質疑Bot接錯話。',actors:['P1'],recipient:'BOT',source_ids:['m1']},{text:'P1與P2對立。',actors:['P1','P2'],recipient:'GROUP',source_ids:['m1']}],quotes:[{message_id:'m2',text:'這群是吃早餐用的'},{message_id:'m2',text:'大家反對彼此'}]},entries,names);
 assert.match(result,/與 Bot 互動.*成員甲/);assert.ok(!/對立|大家反對/u.test(result));assert.match(result,/成員乙：「這群是吃早餐用的」/);
});

test('Bot提問不湊戰力門檻；缺分数與重複participant不偽裝完整榜',()=>{
 const samples=rankingSample([1,2,3].map(i=>({user_id:'a',message_id:'m'+i,ts:i,text:'@AI群聊助手 這是第'+i+'個問題你怎麼看？'})));assert.equal(samples.eligible.length,0);
 const row={id:'P1',clarity:10,responsiveness:10,evidence:5,logic:5,interaction:2,evidence_ids:['m1'],reason:'有理由'};
 const codes=new Map([['a','P1']]),evidence=new Map([['m1',{code:'P1'}]]);
 assert.equal(scoreRanking({participants:[row,row]},codes,evidence).length,1);
 assert.equal(scoreRanking({participants:[{...row,logic:undefined}]},codes,evidence).length,0);
});

test('獎狀指定跳針哥，重貼計數不因背景去重而消失',()=>{
 const rows=[1,2].map(i=>({message_id:'m'+i,user_id:'a',ts:Math.floor(Date.now()/1000)-i,text:'我再貼一次活动名單。'}));const input=conversationalInput('請頒發獎狀給跳針哥',rows,new Map([['a','成員甲']]));
 assert.equal(input.reply_intent,'award');assert.equal(input.target_name,'跳針哥');assert.equal(input.repeated_messages[0].count,2);assert.ok(!JSON.stringify(input).includes('user_id'));
});

test('真實模型漏評案例：外部證據零分，聊天原句ID仍可核對評分',()=>{
 const codes=new Map([['a','P1']]),evidence=new Map([['m1',{code:'P1',text:'應先量測再判斷。'}]]);
 const result=scoreRanking({participants:[{id:'P1',clarity:20,responsiveness:10,evidence:0,logic:15,interaction:5,message_ids:['m1'],reason:'有排查步驟但沒有量測證據'}]},codes,evidence);
 assert.equal(result.length,1);assert.equal(result[0].scores.evidence,0);assert.deepEqual(result[0].proof,['m1']);
});

test('稱呼指令交給模型，可保留貼題加戲而非固定模板',()=>{
 assert.equal(directConversationReply('叫成員甲一聲弟弟'),null);
 const input=conversationalInput('請幫我喊 John 一句「大哥」！',[]);
 assert.equal(input.reply_intent,'playful_address');assert.equal(input.target_name,'John');assert.equal(input.requested_address,'大哥');
 assert.equal(conversationalReply('John，大哥！這聲先欠著，宵夜你請 😎',input),'John，大哥！這聲先欠著，宵夜你請 😎');
 assert.equal(directConversationReply('叫成員甲別亂貼名單'),null);
});

test('純互嗆可讀近期氣氛，過時無關背景與舊民調答案不帶入',()=>{
 const now=Math.floor(Date.now()/1000);
 const input=conversationalInput('你很屌',[{user_id:'a',ts:now-4*3600,text:'今天貼了候選人名單，還聊船員。'},{user_id:'b',ts:now-60,text:'宵夜吃太多，明天要跑步了。'}]);
 prepareConversationMemory(input,[{question:'查證台北選舉民調',answer:'🔎 民調資料整理｜某候選人的支持度。'}]);
 assert.match(input.recent_discussion,/宵夜/);assert.match(input.recent_atmosphere,/跑步/);assert.ok(!/候選人|船員/u.test(input.recent_discussion));assert.deepEqual(input.recent_bot_turns,[]);
});

test('新話題權重高於大量舊話題，去重後不靠重貼堆權重',()=>{
 const now=1800000000;
 const rows=Array.from({length:30},(_,i)=>({user_id:'a',ts:now-3600-i,text:'午餐選項'+i}));
 rows.push({user_id:'b',ts:now-60,text:'晚餐要吃拉麵嗎'}, {user_id:'b',ts:now-30,text:'晚餐要吃拉麵嗎'});
 const input=conversationalInput('你很屌',rows,new Map(),now);
 assert.match(input.recent_discussion,/晚餐/);assert.equal(input.context_priorities.filter(p=>p.text==='晚餐要吃拉麵嗎').length,1);
 const latest=input.context_priorities.find(p=>p.text.includes('晚餐'));
 assert.ok(latest.weight>input.context_priorities.find(p=>p.text.includes('午餐')).weight*3);
 assert.equal(input.context_priorities.length,18);
 assert.ok(!JSON.stringify(input).includes('user_id'));
});

test('明確接續較舊梗可取回，但仍低於同題的新原話',()=>{
 const now=1800000000;
 const input=conversationalInput('洋流船長要怎麼駛舵？',[{user_id:'a',ts:now-3*3600,text:'洋流船長今天負責點餐'},{user_id:'b',ts:now-60,text:'洋流船長現在負責拿外送'},{user_id:'c',ts:now-4*3600,text:'某候選人的民調支持度'}],new Map(),now);
 assert.match(input.recent_discussion,/點餐/);assert.match(input.recent_discussion,/拿外送/);assert.ok(!input.recent_discussion.includes('民調'));
 assert.ok(input.context_priorities[1].weight>input.context_priorities[0].weight);
});

test('未來或缺失時間不冒充最新氣氛，Bot問答也帶時間衰減',()=>{
 const now=1800000000;
 const input=conversationalInput('你想當船長還是船員',[{user_id:'a',ts:now+3600,text:'午餐菜單'},{user_id:'b',text:'早餐菜單'}],new Map(),now);
 assert.equal(input.recent_discussion,'');
 prepareConversationMemory(input,[{ts:now-60,question:'船長？',answer:'我負責外送'},{ts:now-1800,question:'船員？',answer:'我負責點餐'}]);
 assert.equal(input.bot_turn_priorities[0].time_weight,0.5);assert.ok(input.bot_turn_priorities[1].time_weight>0.9);
});

test('粗口清理保留幹話語義，字詞引用不刪成空引號',()=>{
 const input=conversationalInput('不要講垃圾話，請回答',[]);prepareConversationMemory(input,[]);
 const answer=conversationalReply('我不把幹話資料庫當知識庫；也不靠「幹」字充數。',input);
 assert.match(answer,/幹話資料庫/);assert.ok(!answer.includes('「」'));assert.match(answer,/「粗口」/);
});

test('實際回報互嗆進入Bot受話路由，證明不足可取回原任務',()=>{
 for(const question of ['你就繼續講垃圾話 把你淘汰','你滾吧','你這樣講話有人回你嗎'])assert.equal(conversationalInput(question,[]).reply_intent,'banter');
 const input=conversationalInput('你這樣的證明可能還不夠',[]);assert.equal(input.reply_intent,'response_feedback');
 prepareConversationMemory(input,[{question:'證明你比meta ai聰明',answer:'我比Meta聰明的證據就是我沒罵人。'}]);assert.match(input.recent_bot_turns[0].question,/meta ai/);
 assert.ok(conversationIssues('你這樣的證明可能還不夠，那我來證明你這樣說還不夠夠夠夠～',input).includes('echo_instead_of_answer'));
 assert.ok(conversationIssues('我比Meta AI聰明的證據就是我沒罵人。',input).includes('unsupported_comparison'));
 assert.ok(!conversationIssues('沒有共同測試，不能證明我比Meta AI聰明。',input).includes('unsupported_comparison'));
 const banter=conversationalInput('你滾吧',[]);
 assert.ok(conversationIssues('我已經把群組設定成自動回復模式了。',banter).includes('invented_group_action'));
 assert.equal(conversationalReply('你滾吧\n好啦，退場不用演三集。',banter),'好啦，退場不用演三集。');
});

test('背景作者說過的話不能變成提問者自己的經歷，明確原話仍可接續',()=>{
 const input=conversationalInput('你這樣講話有人回你嗎',[]);
 assert.ok(conversationIssues('有人回啊，不然我怎麼知道你剛剛在討論洋流船員名單和宵夜炸雞？',input).includes('invented_requester_history'));
 input.requester_discussion='我剛剛貼了洋流船員名單和宵夜炸雞。';
 assert.ok(!conversationIssues('你剛剛說洋流船員名單和宵夜炸雞。',input).includes('invented_requester_history'));
});
