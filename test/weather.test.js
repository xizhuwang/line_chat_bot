import test from 'node:test';
import assert from 'node:assert/strict';
import {weatherRequest} from '../src/weather.js';

test('明後天依台灣日期，跨年也正確；缺城市或日期範圍會追問',()=>{
  const now=Date.parse('2026-12-31T17:00:00Z');
  assert.equal(weatherRequest('台北明天天氣',now).date,'2027-01-02');
  assert.equal(weatherRequest('臺北後天天氣',now).date,'2027-01-03');
  assert.ok(weatherRequest('明天天氣',now).clarify);
  assert.ok(weatherRequest('台北下週天氣',now).clarify);
  assert.equal(weatherRequest('查證氣象署預算是否通過'),null);
  assert.equal(weatherRequest('台北歷史最高氣溫達41度'),null);
});
