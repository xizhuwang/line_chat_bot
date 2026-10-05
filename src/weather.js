const CITIES = [
  ['台北','Taipei'],['新北','New Taipei'],['桃園','Taoyuan'],['台中','Taichung'],['台南','Tainan'],['高雄','Kaohsiung'],
  ['基隆','Keelung'],['新竹','Hsinchu'],['嘉義','Chiayi'],['苗栗','Miaoli'],['彰化','Changhua'],['南投','Nantou'],
  ['宜蘭','Yilan'],['花蓮','Hualien'],['台東','Taitung'],['屏東','Pingtung'],
];
const CONDITION = {0:'晴',1:'大致晴朗',2:'局部多雲',3:'陰天',45:'霧',48:'霧凇',51:'小毛毛雨',53:'毛毛雨',55:'較強毛毛雨',
  56:'凍毛毛雨',57:'較強凍毛毛雨',61:'小雨',63:'中雨',65:'大雨',66:'凍雨',67:'較強凍雨',71:'小雪',73:'中雪',75:'大雪',
  77:'雪粒',80:'小陣雨',81:'中陣雨',82:'強陣雨',85:'小陣雪',86:'較強陣雪',95:'雷雨',96:'雷雨伴冰雹',97:'強雷雨',99:'雷雨伴較強冰雹'};

export function weatherRequest(text, now=Date.now()) {
  if (!/天氣|天候|天氣預報|會不會下雨|降雨機率|氣溫/u.test(text) || /氣象署.*(?:預算|政策|造假|法案)|為什麼|原理/u.test(text)) return null;
  if(!/今天|明天|後天|現在|天氣(?:預報|如何|怎樣|怎麼樣|[?？]?\s*$)|氣溫(?:多少|幾度)|會不會下雨|降雨機率.*(?:多少|如何)/u.test(text)) return null;
  const clean=text.replace(/臺/g,'台');
  const city=CITIES.find(([name])=>clean.includes(name));
  if(!city) return {clarify:'哪個城市的天氣？給我地點啦，例如「查證 台北明天天氣」。'};
  if(clean.includes(`${city[0]}縣`)) return {clarify:'這個縣範圍很大，請給具體城市或鄉鎮；目前可先查縣治城市的預報。'};
  const offset=/後天/.test(clean)?2:/明天/.test(clean)?1:0;
  const date=new Date(now+8*3600000+offset*86400000).toISOString().slice(0,10);
  if (/下週|下星期|昨天|上週|\d{1,4}[/-]\d{1,2}/u.test(clean)) return {clarify:'先指定今天、明天或後天吧；這個查詢目前提供這三天的預報。'};
  return {name:city[0],geocode:city[1],date};
}

async function json(url) {
  const response=await fetch(url,{signal:AbortSignal.timeout(6000)});
  if(!response.ok) throw new Error('WEATHER_UNAVAILABLE');
  const result=await response.json();
  if(result.error) throw new Error('WEATHER_UNAVAILABLE');
  return result;
}

export async function weatherReport(request,now=Date.now()) {
  if(request.clarify) return request.clarify;
  const geoURL=new URL('https://geocoding-api.open-meteo.com/v1/search');
  geoURL.search=new URLSearchParams({name:request.geocode,count:'5',language:'zh',format:'json',countryCode:'TW'});
  const geo=await json(geoURL);
  const places=(geo.results || []).filter(p=>p.country_code==='TW'&&Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)&&/^PPL/.test(p.feature_code||''));
  places.sort((a,b)=>(b.population||0)-(a.population||0));
  const place=places[0];
  if(!place) return '找不到這個城市的預報位置，請換更明確的地名；這次不猜天氣。';
  const forecastURL=new URL('https://api.open-meteo.com/v1/forecast');
  forecastURL.search=new URLSearchParams({latitude:String(place.latitude),longitude:String(place.longitude),timezone:'Asia/Taipei',
    daily:'weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max',start_date:request.date,end_date:request.date});
  const data=await json(forecastURL);
  const index=data.daily?.time?.indexOf(request.date) ?? -1;
  const low=data.daily?.temperature_2m_min?.[index], high=data.daily?.temperature_2m_max?.[index], rain=data.daily?.precipitation_probability_max?.[index];
  if(index<0||!Number.isFinite(low)||!Number.isFinite(high)||!Number.isFinite(rain)||rain<0||rain>100||low>high||
      data.daily_units?.temperature_2m_min!=='°C'||data.daily_units?.temperature_2m_max!=='°C'||data.daily_units?.precipitation_probability_max!=='%') throw new Error('WEATHER_UNAVAILABLE');
  const stamp=new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',dateStyle:'short',timeStyle:'short'}).format(now);
  return `🌤️ ${request.name}｜${request.date} 全天預報（城市代表點）\n${CONDITION[data.daily.weather_code?.[index]]||'天氣型態未提供'}，${low}～${high}°C\n當日最高降雨機率：${rain}%\n查詢：${stamp} 台灣時間\n這是模式預報，實際天氣仍可能變動；重大天氣警報請看中央氣象署。\n資料：Open-Meteo；地名：GeoNames\nhttps://open-meteo.com/\nhttps://www.geonames.org/\nhttps://www.cwa.gov.tw/`;
}
