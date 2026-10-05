import test from "node:test";
import assert from "node:assert/strict";
import { searchQuery, normalizeSources, renderFactCheck, searchMonthlyLimit } from "../src/factcheck.js";

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
  assert.match(good, /部分支持/);
  assert.match(good, /https:\/\/law\.moj\.gov\.tw\/test/);
  assert.ok(!good.includes("S99"));
});
