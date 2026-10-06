export const MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
export const MAX_REPLY = 4900;

export function rankingText(text = "") {
  const clean = String(text).trim().replace(/^(?:@\S+\s+)+/u, "").trim();
  if (/^\//.test(clean)) return null;
  const plain = clean.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  if (!plain || /^(?:你好|您好|嗨|哈囉|哈啰|早安|午安|晚安|在嗎|測試|測試一下|試試|有收到嗎|有回覆嗎|hello|hi|hey|test)+$/u.test(plain)) return null;
  return plain.length >= 8 ? clean : null;
}

export function rankingSample(rows, perPerson = 30, total = 240) {
  const grouped = new Map();
  const seen = new Map();
  for (const row of rows) {
    const meaningful = rankingText(row.text);
    if (!meaningful) continue;
    if (!grouped.has(row.user_id)) { grouped.set(row.user_id, []); seen.set(row.user_id, new Set()); }
    if (seen.get(row.user_id).has(meaningful)) continue;
    seen.get(row.user_id).add(meaningful);
    grouped.get(row.user_id).push(row);
  }
  const eligible = [...grouped].filter(([, messages]) => messages.length >= 3);
  // Give each member the same share, then distribute unused slots to longer histories.
  const allocations = eligible.map(([, messages]) => Math.min(messages.length, perPerson, Math.floor(total / Math.max(1, eligible.length))));
  let remaining = total - allocations.reduce((sum, count) => sum + count, 0);
  while (remaining > 0) {
    let changed = false;
    for (let i = 0; i < eligible.length && remaining > 0; i++) {
      if (allocations[i] >= Math.min(eligible[i][1].length, perPerson)) continue;
      allocations[i]++; remaining--; changed = true;
    }
    if (!changed) break;
  }
  const selected = eligible.flatMap(([, messages], i) => allocations[i] === 1 ? [messages.at(-1)] : allocations[i] ? evenly(messages, allocations[i]) : [])
    .sort((a, b) => a.ts - b.ts || a.message_id.localeCompare(b.message_id));
  return { eligible, selected, available: eligible.reduce((sum, [, messages]) => sum + messages.length, 0) };
}

export function dailyAiLimit(env = {}) {
  const value = Number(env.DAILY_AI_LIMIT ?? 300);
  return Number.isInteger(value) && value >= 1 && value <= 10000 ? value : 300;
}

// LINE mention offsets use UTF-16 code units, matching JavaScript string offsets.
export function botMentionPrompt(message, destination) {
  const text = message?.text;
  if (typeof text !== "string") return null;
  const mentions = (message.mention?.mentionees || []).filter(m =>
    m.type === "user" && (m.isSelf === true || (destination && m.userId === destination)) &&
    Number.isInteger(m.index) && Number.isInteger(m.length) && m.index >= 0 &&
    m.length > 0 && m.index + m.length <= text.length);
  if (!mentions.length) return null;
  let prompt = text;
  for (const m of mentions.sort((a, b) => b.index - a.index)) {
    prompt = prompt.slice(0, m.index) + prompt.slice(m.index + m.length);
  }
  return prompt.trim();
}

export async function verifyLineSignature(secret, body, provided) {
  if (!secret || !provided) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  const expected = btoa(String.fromCharCode(...signature));
  if (expected.length !== provided.length) return false;
  let different = 0;
  for (let i = 0; i < expected.length; i++) different |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return different === 0;
}

export function taipeiDayStart(now = Date.now()) {
  const local = new Date(now + 8 * 3600_000);
  return Math.floor(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) / 1000) - 8 * 3600;
}

export function evenly(rows, limit) {
  if (rows.length <= limit) return rows;
  return Array.from({ length: limit }, (_, i) => rows[Math.round(i * (rows.length - 1) / (limit - 1))]);
}

export function pseudonyms(rows) {
  const codes = new Map();
  for (const row of rows) if (!codes.has(row.user_id)) codes.set(row.user_id, `P${codes.size + 1}`);
  return codes;
}

export function discussionContext(rows, maxCharacters = 10000, codes = pseudonyms(rows)) {
  const lines = [];
  let length = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const text = row.text.slice(0, 400);
    const previous = rows[i + 1];
    if (previous?.user_id === row.user_id && previous.text === row.text) continue;
    const time = new Date((row.ts + 8 * 3600) * 1000).toISOString().slice(5, 16).replace('T', ' ');
    const line = `[${time} ${codes.get(row.user_id)}] ${text}`;
    if (length + line.length + 1 > maxCharacters) break;
    lines.unshift(line);
    length += line.length + 1;
  }
  return lines.join('\n');
}

export function revealCodes(text, names) {
  return text.replace(/(^|[^A-Za-z0-9])P\d+(?!\d)/g, (match, prefix) => {
    const code = match.slice(prefix.length);
    return prefix + (names.get(code) || code);
  });
}

export function engineeringTopic(text) {
  return /電機|電路|電源|電壓|電流|電阻|電容|電感|類比|低通|高通|數位IC|數位 IC|時序|跨時脈|亞穩態|運算放大器|增益|相位裕度|製程角|\b(?:AIC|DIC|RC|RTL|Verilog|SystemVerilog|VHDL|CDC|STA|setup|hold|FPGA|ASIC|MOSFET|CMOS|PLL|ADC|DAC|LDO|OTA|op[- ]?amp|IC|PVT|SPICE|EMI|EMC|timing|metastability|jitter|slew|phase margin|Bode)\b/iu.test(text);
}

export function isAicDefinition(question) {
  const clean = question.replace(/[\s，,。!！?？]/gu, '');
  return /^(?:(?:你(?:知道|曉得)?|請問|你說的)?(?:什麼是AIC|AIC是什麼(?:意思)?|AIC(?:的)?意思(?:是什麼)?)(?:嗎|呢)?)$/iu.test(clean);
}

function replyFingerprint(text) { return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu,''); }

function nearlySameReply(left, right) {
  const a=replyFingerprint(left), b=replyFingerprint(right);
  if(a===b) return true;
  if(Math.min(a.length,b.length)<40) return false;
  const pairs=text=>new Set(Array.from({length:text.length-1},(_,i)=>text.slice(i,i+2)));
  const x=pairs(a), y=pairs(b);
  const shared=[...x].filter(pair=>y.has(pair)).length;
  return 2*shared/(x.size+y.size)>=0.85;
}

export function toneFeedback(question) {
  return /(?:不要|別|少|停止).{0,10}(?:髒話|粗口|幹幹叫|靠[北杯]|罵人|嘴砲|鬧)|(?:好好|認真).{0,4}(?:回答|說話)|只會.{0,8}(?:幹幹叫|靠[北杯])/u.test(question);
}

function tonePreference(question) {
  if(toneFeedback(question)) return 'restrained';
  return /(?:恢復|回到|繼續).{0,5}(?:嘴砲|嗆人)|(?:嗆|嘴賤|北爛)一點|可以.{0,4}(?:嘴砲|罵人)/u.test(question) ? 'contextual' : null;
}

function actionFeedback(question) {
  return /^(?:你)?(?:有夠懶|很懶|只會嘴|只會靠[北杯]|不要只會靠[北杯])[!！?？。\s]*$/u.test(question);
}

export function banterIntent(question) {
  return /^(?:你很屌|你他媽|你很猛|你很嘴|有夠懶)[!！?？。\s]*$/u.test(question) ||
    /^(?:你給我|你|妳)?(?:自動)?退群[!！?？。\s]*$/u.test(question) ||
    /^(?:你|妳)?自己下船|最後一班船/u.test(question);
}

function lastSearchTopic(turns) {
  for(const turn of turns) {
    const carried=turn.question.match(/\n查詢主題：([^\n]+)/u)?.[1];
    if(carried) return {claim:carried,turn};
    const explicit=requestedSearch(turn.question.replace(/^\/查證\s*/u,'查證 '));
    if(explicit) return {claim:explicit,turn};
    if(explicit===null && !toneFeedback(turn.question) && !actionFeedback(turn.question) && !/^(?:所以|那|這樣|你剛|前面|上一)/u.test(turn.question)) return null;
  }
  return null;
}

export function resolveSearchRequest(question, turns=[]) {
  const requested=requestedSearch(question);
  if(requested===null && /誰會贏|誰會輸|誰勝|(?:贏面|勝算).{0,6}(?:大|高)|會贏嗎/u.test(question) && /民調/u.test(lastSearchTopic(turns)?.claim || '')) return null;
  const correction=question.match(/^(?:現在是|目前是|我是說|我說的是)\s*(.{2,100})[。!！?？]?$/u)?.[1];
  if(requested===null && !actionFeedback(question) && !correction) return null;
  if(requested) return {claim:requested,turns:[]};
  const topic=lastSearchTopic(turns);
  if(correction && topic) return {claim:`${topic.claim} 核對更正：${correction}`,turns:[topic.turn]};
  return topic ? {claim:topic.claim,turns:[topic.turn]} : requested===null ? null : {claim:'',turns:[]};
}

export function prepareConversationMemory(input, candidates) {
  input.tone_mode = tonePreference(input.question) || candidates.map(turn=>tonePreference(turn.question)).find(Boolean) || 'contextual';
  const turns = selectBotTurns(input, candidates);
  input.recent_bot_turns = turns.slice().reverse().map(turn=>({question:turn.question,answer:turn.answer}));
  input.repeated_question_count = turns.filter(turn=>
    replyFingerprint(turn.question)===replyFingerprint(input.question) || (isAicDefinition(input.question)&&isAicDefinition(turn.question))).length;
  if (input.reply_intent === 'response_feedback' && turns.some(turn=>/\bAIC\b/i.test(turn.question))) {
    input.term_definitions = {AIC:'類比 IC（Analog IC）'};
    input.topic_hint = 'engineering';
  }
  const checked=turns.slice().find(turn=>/🔎 (?:即時資料核對|民調資料整理)/u.test(turn.answer));
  if(checked && input.topic_hint!=='engineering' && /民調/u.test(checked.question) && /民調|會贏|會輸|勝選|五五波|穩贏|贏面|差距|比例|怎麼看|解讀|代表什麼/u.test(input.question)) {
    input.reply_intent='poll_followup';
  }
  return turns;
}

export function selectBotTurns(input, turns) {
  if(input.reply_intent==='tone_feedback') return turns.slice(0,2);
  if (input.reply_intent === 'term_definition') return turns.filter(turn=>isAicDefinition(turn.question));
  if (input.reply_intent === 'response_feedback') return turns.slice(0,2);
  if (!['conversation','banter'].includes(input.reply_intent)) return [];
  const question = input.question.trim();
  if(/誰會贏|誰會輸|誰勝|(?:贏面|勝算).{0,6}(?:大|高)|會贏嗎/u.test(question) && /民調/u.test(lastSearchTopic(turns)?.claim || '')) return [lastSearchTopic(turns).turn];
  if (/^(?:所以|那麼|也就是|這樣說|那這|照這)/u.test(question) && question.length<=80) return turns.slice(0,3);
  // Only an actual follow-up may carry a prior answer into a new prompt.
  if (/最後一班船|(?:上|下)船|碼頭/u.test(question)) {
    return turns.filter(t => /船|碼頭/u.test(`${t.question}\n${t.answer}`)).slice(0, 2);
  }
  if (/^(?:你很屌|你他媽|你很猛|你很嘴)[!！?？。\s]*$/u.test(question)) return turns.slice(0, 1);
  if (/^(?:你覺得呢|這樣合理嗎|為什麼|怎麼說|然後呢|所以呢|那接著呢|繼續|說清楚一點)[?？!！。\s]*$/u.test(question) ||
      /^(?:你剛(?:剛|才)說|剛(?:剛|才)那|前面那|上一(?:句|題|段)|你在不管什麼|你.*我在問你問題)/u.test(question)) return turns;
  // Recognize callbacks such as「那班長是誰」without making a stock joke permanent.
  if (/^(?:那|這)/u.test(question) && question.length <= 24) {
    const common = new Set(['那個','這個','什麼','麼是','是誰','一下','實力','就是','為什','你說','你是','在哪','怎麼','然後']);
    const phrases = [...question.matchAll(/[\p{Script=Han}]{2,}/gu)].flatMap(([part]) =>
      Array.from({length:part.length-1},(_,i)=>part.slice(i,i+2))).filter(p=>!common.has(p));
    return turns.filter(turn=>phrases.some(p=>turn.answer.includes(p))).slice(0,2);
  }
  return [];
}

export function conversationalInput(question, rows) {
  // A request addressed to the bot is not evidence that its subject experienced an event.
  const chat = rows.filter(row => !/^\s*\//u.test(row.text) && !/@(?:AI群聊助手|AI)(?:\s|$)/iu.test(row.text));
  const cheer = question.match(/^(?:請)?(?:幫|替)(.{1,20}?)(?:加油|打氣|鼓勵)/u);
  const overtime = question.match(/^(?:請問)?(?:為什麼|為何|怎麼)(.{1,20}?)(?:還(?:在)?|一直|又|在)加班/u);
  const roast = question.match(/^(?:幫我)?叫(.{1,20}?)(?:別|不要)/u);
  const demonstration = /見識.*(?:實力|本事|能力)|(?:展示|秀出|秀一下|展現|露一手).*(?:實力|本事|能力|AI|IC)/iu.test(question);
  const termCorrection = /(?:^|[，,])(?:是|我說的是|我是指|我指的是|這裡指的是)\s*類比\s*IC[。!！?？\s]*$/iu.test(question);
  const responseFeedback = /你(?:怎麼|為什麼|幹嘛).{0,12}(?:重複|跳針|罐頭)|你.{0,8}(?:一直|又|老是).{0,8}(?:重複|跳針)|(?:不要|別|停止).{0,8}(?:重複|跳針|罐頭)|(?:回覆|回答|內容).{0,8}(?:一樣|重複|罐頭)/u.test(question);
  const target = (cheer?.[1] || overtime?.[1] || roast?.[1] || '').trim();
  const intent = toneFeedback(question) ? 'tone_feedback' : responseFeedback ? 'response_feedback' : cheer ? 'encouragement' : overtime ? 'unknown_overtime_reason' : roast ? 'roast' : demonstration ? 'demonstration' : termCorrection ? 'term_correction' : isAicDefinition(question) ? 'term_definition' : banterIntent(question) ? 'banter' : 'conversation';
  const technical = engineeringTopic(question);
  const related = target ? chat.filter(row => row.text.includes(target)) : demonstration || termCorrection ? [] : technical ? chat.filter(row => engineeringTopic(row.text)) : chat;
  const codes = pseudonyms(related);
  return { question, reply_intent: intent, topic_hint: technical ? 'engineering' : 'general', target_name: target || null,
    term_definitions: /\bAIC\b/i.test(question) || termCorrection ? {AIC:'類比 IC（Analog IC）'} : {}, recent_discussion: discussionContext(related,10000,codes),
    recent_atmosphere: discussionContext(related.filter(row=>row.ts>=Math.floor(Date.now()/1000)-20*60).slice(-12),3000,codes) };
}

function differentReply(options, past) {
  const used = new Set(past.map(turn=>replyFingerprint(turn.answer)));
  return options.find(option=>!used.has(replyFingerprint(option))) || options[0];
}

function aicFallback(input, feedback=false) {
  const options = feedback ? [
    '剛剛回得像影印機，這點算我的。換個白話講：AIC 就是類比 IC，處理連續變化的電壓、電流，像放大、濾波、穩壓這些事。',
    '對，剛剛我把同一段照貼了。補個實際例子：感測器訊號太小，先靠類比前端放大或濾波，再交給後面的數位電路處理。',
  ] : [
    '知道，這裡 AIC 就是 Analog IC、類比 IC。它處理連續變化的電壓或電流；放大器、電壓參考和 LDO 都是常見例子。',
    '換個白話版本：AIC 是類比 IC，主要跟電壓、電流這些連續訊號打交道，做放大、濾波或穩壓；這群就用這個意思聊。',
    'AIC 在這裡指類比 IC。拿感測器當例子，微弱訊號先經類比前端放大、濾波，再交給後續電路處理，這就比背縮寫更具體了。',
  ];
  if(!feedback && input.repeated_question_count>0) options.unshift(options.pop());
  return differentReply(options,input.recent_bot_turns || []);
}

export function conversationalReply(text, input) {
  let answer = text.trim().replace(/\bP\d+\b/g, '前面那位');
  const past = input.recent_bot_turns || [];
  if(input.reply_intent==='tone_feedback') return '收到，剛剛嘴過頭了。我會少講髒話，先把問題答清楚。';
  if(input.reply_intent==='banter' && /防踢系統|踢不(?:動|走)|有權.{0,5}(?:阻止|拒絕).{0,4}(?:踢|退群)/u.test(answer)) {
    return '嘴輸了就趕我走喔？我還沒領便當欸 😎';
  }
  if(input.reply_intent==='poll_followup' &&
      (/無聊|太陽.*升起|還不快去查|自己去查|穩贏|必勝|一定會贏|五五波|選戰還很久|選舉還(?:很久|早)/u.test(answer) || !/民調|調查|預測|勝選/u.test(answer))) {
    return '不能這樣推，民調不是開票機。前面那份資料還不足以判定誰會贏；先看調查日期和方法，別把街訪、聲量跟支持度混成一鍋。';
  }
  if(input.reply_intent==='poll_followup') {
    answer=answer.replace(/(差(?:距)?(?:不到|約|只有|為|是|近|小於|大於)?\s*\d+(?:\.\d+)?)\s*[%％]/gu,'$1個百分點');
    if(past.some(turn=>/調查日期：來源片段未提供|調查日期或方法沒附完整/u.test(turn.answer))) answer=answer.replace(/目前|現在/gu,'在那份調查中');
  }
  if(input.tone_mode==='restrained') answer=answer.replace(/(?:靠北|靠杯|幹(?:你娘|他媽)?(?!嘛|部|線|活)|他媽的?|屁啦|是在供三小)[，,！!\s]*/gu,'').trim();
  const duplicates = past.some(turn=>nearlySameReply(turn.answer,answer));
  if (input.reply_intent === 'term_correction' && !/類比\s*IC|Analog\s*IC/iu.test(answer)) {
    return '收到，這個群組的 AIC 就是類比 IC（Analog IC），我會照這個意思接話。';
  }
  const wrongMeaning = /人工智[慧能].{0,6}(?:芯片|晶片)|Artificial\s+Intelligence\s+Chip|AI\s*卡|NPU|沒有標準|並無標準/iu.test(answer);
  if (isAicDefinition(input.question) && (wrongMeaning || duplicates || !/類比\s*IC|Analog\s*IC/iu.test(answer))) {
    return aicFallback(input);
  }
  if (input.reply_intent === 'term_correction' && wrongMeaning) {
    return '對，這裡說的是類比 IC（Analog IC），我照這個意思接話。';
  }
  if (input.reply_intent === 'response_feedback' && input.term_definitions?.AIC &&
      (duplicates || /練習|專業技能|要不要.{0,8}(?:變化|換|改)|這還用問|(?:剛|才)入行/u.test(answer) || !/類比\s*IC|Analog\s*IC|感測器|放大|濾波/iu.test(answer))) {
    return aicFallback(input,true);
  }
  const unrelatedBoat = /船|碼頭|航行|證照/u.test(answer) && !/船|碼頭|航行|證照/u.test(input.question);
  const asksAudienceToSolve = /請問|先自己算|你(?:們)?先算|先算一下|(?:增益|輸出).{0,8}多少/u.test(answer);
  const calculatedResult = /(?:[=＝]|約(?:為|等於)?|(?:增益|輸出|時間常數|截止頻率).{0,15}(?:為|是))\s*[−\-+]?\d/u.test(answer);
  if (input.reply_intent === 'demonstration' && input.term_definitions?.AIC &&
      (unrelatedBoat || (asksAudienceToSolve && !calculatedResult))) {
    return '先來個類比小題：理想反相放大器在線性負回授下，Rin=10 kΩ、Rf=100 kΩ，增益就是 −10；輸入 20 mV，輸出 −200 mV。實際電路還要檢查頻寬、輸出擺幅與穩定度，公式會背不代表電路就會乖 😎';
  }
  if (/^(?:請問)?(?:你(?:是|知道)?誰.*(?:拉|邀|加).*(?:群|進來)|誰.*(?:拉|邀|加)你.*(?:群|進來))/u.test(input.question)) {
    return '我收到的資料沒顯示誰拉我進來，別叫我亂認親啦 😂';
  }
  if (input.reply_intent === 'encouragement') {
    const supplied = `${input.question}\n${input.recent_discussion}`;
    const invented = [...answer.matchAll(/酸民|道歉|自責|犯錯|搞砸|被凹|加班|失敗|難過|搶功|對手|被罵|誠懇/g)]
      .some(([term]) => !supplied.includes(term));
    if (invented || /大家都支持|我們都支持|你已經做得很好/.test(answer)) {
      return `${input.target_name}，加油啦！嘴砲可以輸，氣勢不能輸 😎`;
    }
  }
  if (/我(?:可以|會|來)?幫你(?:去)?(?:問問|問他|私訊|打電話|聯絡)/.test(answer)) {
    return '我沒辦法代你去問人啦 😂 把背景丟過來，我可以幫你想怎麼接話。';
  }
  return answer;
}

export function requestedSearch(question) {
  if(/^(?:你|幫我|麻煩你)\s*(?:查查|查一下|查詢|搜尋|查)\s*[啊阿啦呀吧]?(?:[!！?？。，,\s]|不要|別|$)/u.test(question.trim())) return '';
  const match = question.trim().match(/^(?:(?:請(?:你)?|麻煩(?:你)?|幫我)\s*)?(?:查證|查詢|查一下|搜尋|搜一下|查查)(?:\s*(?:並)?回(?:應|答)我)?[\s:：]*(.*)$/u);
  if(match) return match[1].trim();
  const text=question.trim();
  const fresh=/本日|今日|今天|最新|目前|現在|最近|即時/u.test(text);
  const conceptual=/什麼是|是什麼|定義|原理|怎麼做|如何做|怎麼看|解讀|代表什麼|差距|抽樣誤差/u.test(text);
  if(!/(?:不要|別).{0,4}(?:查|搜)/u.test(text) &&
      ((/民調/u.test(text) && (!conceptual || fresh) && /本日|今日|今天|最新|目前|最近|選舉|市長|台北|臺北/u.test(text)) ||
       (!conceptual && /新聞|(?:最新|今日|今天|本日|最近).{0,10}(?:報導|消息)/u.test(text)) ||
       (fresh && !conceptual && /發布|價格|匯率|職務|人事|(?:工具|軟體|EDA).{0,6}版本/u.test(text)))) return text;
  return null;
}

export function extractAiText(result) {
  const content = typeof result?.response === "string" ? result.response : result?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    const answer = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    if (answer && !/<\/?think>/i.test(answer)) return answer;
  }
  throw new Error("Workers AI 回應沒有文字");
}

export function parseJsonText(text) {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(clean);
}

export function scoreRanking(parsed, codes, evidence) {
  const max = { clarity: 25, responsiveness: 25, evidence: 20, logic: 20, interaction: 10 };
  const allowed = new Set(codes.values());
  const output = [];
  for (const row of parsed?.participants || []) {
    if (!allowed.has(row.id) || typeof row.reason !== "string") continue;
    const proof = (Array.isArray(row.evidence_ids) ? row.evidence_ids : [])
      .filter(id => evidence.get(id)?.code === row.id).slice(0, 2);
    if (!proof.length) continue;
    const scores = Object.fromEntries(Object.entries(max).map(([field, top]) => {
      const value = Number(row[field]);
      return [field, Number.isFinite(value) ? Math.max(0, Math.min(top, Math.trunc(value))) : 0];
    }));
    output.push({ code: row.id, total: Object.values(scores).reduce((a, b) => a + b, 0),
      scores, proof, reason: row.reason.slice(0, 100) });
  }
  return output.sort((a, b) => b.total - a.total || a.code.localeCompare(b.code));
}
