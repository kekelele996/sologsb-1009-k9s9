// 对账纯逻辑断言（不依赖 Astro，直接用 typescript 转译后用 Node 跑）：
//   node scripts/test-reconciliation.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
function loadTs(relativePath) {
  const sourcePath = join(here, "..", relativePath);
  const source = readFileSync(sourcePath, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dataUrl = "data:text/javascript;base64," + Buffer.from(js).toString("base64");
  return import(dataUrl);
}

const { reconcileParagraphs, mergeBackfillQueue } = await loadTs("src/scripts/reconciliation.ts");

const T0 = 1_000_000_000_000;
const day = 86_400_000;
const block = (paraRef, contentUpdatedAt, localReviewed = false) => ({ paraRef, contentUpdatedAt, localReviewed });
const item = (paraRef, decision, issuedAt) => ({ paraRef, decision, issuedAt });
const sheet = (items, issuedAt = T0) => ({ sheetNo: "S1", issuedAt, items });

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`✓ ${name}`); };

/* 1. 在线：通过 → 已复核 */
test("在线实时单：通过结论标已复核", () => {
  const r = reconcileParagraphs(
    [block("p1", T0 - day)],
    { live: sheet([item("p1", "pass", T0)]), cached: null },
  );
  assert.equal(r.source, "live");
  assert.equal(r.rows[0].mark, "reviewed");
  assert.equal(r.rows[0].stale, false);
  assert.equal(r.reviewedCount, 1);
});

/* 2. 在线：退回 → 待改（照旧导出） */
test("退回结论标待改，不拦截导出", () => {
  const r = reconcileParagraphs(
    [block("p1", T0 - day)],
    { live: sheet([item("p1", "return", T0)]), cached: null },
  );
  assert.equal(r.rows[0].mark, "pending-revision");
  assert.equal(r.rows[0].needsReconfirm, false);
});

/* 3. 在线：无结论 → 未复核，且不进待补（只是还没给） */
test("审校单未给结论 → 未复核，不进待补清单", () => {
  const r = reconcileParagraphs([block("p1", T0 - day, true)], { live: sheet([]), cached: null });
  assert.equal(r.rows[0].mark, "unreviewed");
  assert.equal(r.rows[0].pendingBackfill, false);
  assert.equal(r.backfill.length, 0);
  assert.match(r.rows[0].note, /本地已复核/);
});

/* 4. 本地已审过、审校单无结论 → 仍未复核 */
test("本地复核不作数：localReviewed=true 且无结论仍未复核", () => {
  const r = reconcileParagraphs([block("p1", T0 - day, true)], { live: sheet([]), cached: null });
  assert.equal(r.rows[0].mark, "unreviewed");
});

/* 5. 改动晚于通过结论 → 通过失效，记未复核并要求重新确认（在线不进待补） */
test("改动晚于审校单通过结论：不能再算通过", () => {
  const r = reconcileParagraphs(
    [block("p3", T0 + day)],
    { live: sheet([item("p3", "pass", T0)]), cached: null },
  );
  assert.equal(r.rows[0].mark, "unreviewed");
  assert.equal(r.rows[0].stale, true);
  assert.equal(r.rows[0].needsReconfirm, true);
  assert.equal(r.rows[0].pendingBackfill, false);
  assert.deepEqual(r.reconfirm.map((x) => x.paraRef), ["p3"]);
});

/* 6. 同一时刻（出具时间 == 改动时间）不算失效 */
test("结论时间等于改动时间仍有效（严格早于才失效）", () => {
  const r = reconcileParagraphs(
    [block("p2", T0)],
    { live: sheet([item("p2", "pass", T0)]), cached: null },
  );
  assert.equal(r.rows[0].mark, "reviewed");
});

/* 7. 退回结论即使早于改动，仍按待改导出，同时请重新确认 */
test("退回结论早于改动：仍标待改并提示重新确认", () => {
  const r = reconcileParagraphs(
    [block("img", T0 + day)],
    { live: sheet([item("img", "return", T0)]), cached: null },
  );
  assert.equal(r.rows[0].mark, "pending-revision");
  assert.equal(r.rows[0].stale, true);
  assert.equal(r.rows[0].needsReconfirm, true);
});

/* 8. 离线 + 无缓存：未复核且进待补 */
test("审校单取不到且无缓存：未复核并进待补清单", () => {
  const r = reconcileParagraphs([block("p1", T0 - day), block("p2", T0 - day)], { live: null, cached: null });
  assert.equal(r.source, "unavailable");
  assert.equal(r.rows[0].mark, "unreviewed");
  assert.equal(r.backfill.length, 2);
  assert.deepEqual(r.backfill.map((x) => x.paraRef), ["p1", "p2"]);
});

/* 9. 离线 + 缓存：新鲜通过按缓存算已复核（fromCache），未给结论进待补 */
test("离线时缓存新鲜通过仍标已复核，无结论段进待补", () => {
  const cached = { sheet: sheet([item("p1", "pass", T0)]), fetchedAt: T0 + day };
  const r = reconcileParagraphs([block("p1", T0 - day), block("p2", T0 - day)], { live: null, cached });
  assert.equal(r.rows[0].mark, "reviewed");
  assert.equal(r.rows[0].fromCache, true);
  assert.equal(r.rows[1].mark, "unreviewed");
  assert.deepEqual(r.backfill.map((x) => x.paraRef), ["p2"]);
});

/* 10. 离线 + 缓存通过已被改动作废 → 未复核且进待补，恢复后必须补 */
test("离线时缓存通过已失效：未复核并进待补", () => {
  const cached = { sheet: sheet([item("p3", "pass", T0)]), fetchedAt: T0 + day };
  const r = reconcileParagraphs([block("p3", T0 + 2 * day)], { live: null, cached });
  assert.equal(r.rows[0].mark, "unreviewed");
  assert.equal(r.rows[0].pendingBackfill, true);
  assert.equal(r.rows[0].needsReconfirm, true);
});

/* 11. 离线 + 缓存退回：新鲜退回标待改但不进待补；陈旧退回也标待改并进待补 */
test("离线缓存退回：新鲜待改不进待补；陈旧待改进待补", () => {
  const cached = {
    sheet: sheet([item("a", "return", T0), item("b", "return", T0)]),
    fetchedAt: T0 + day,
  };
  const r = reconcileParagraphs([block("a", T0 - day), block("b", T0 + 2 * day)], { live: null, cached });
  assert.equal(r.rows[0].mark, "pending-revision");
  assert.equal(r.rows[0].pendingBackfill, false);
  assert.equal(r.rows[1].mark, "pending-revision");
  assert.equal(r.rows[1].pendingBackfill, true);
});

/* 12. 待补队列合并：恢复后实时单给了结论 → 出队；仍无结论（在线）→ 也出队且记未复核 */
test("连接恢复后按段落编号消化待补队列", () => {
  const previous = [
    { paraRef: "p1", reason: "x", since: 1 },
    { paraRef: "p2", reason: "x", since: 2 },
  ];
  const liveResult = reconcileParagraphs(
    [block("p1", T0 - day), block("p2", T0 - day)],
    { live: sheet([item("p1", "pass", T0)]), cached: null }, // p2 在线但无结论
  );
  const merged = mergeBackfillQueue(previous, liveResult, T0 + 3 * day);
  assert.deepEqual(merged, []); // 实时取单成功本身不产生待补
  assert.equal(liveResult.rows[0].mark, "reviewed");
  assert.equal(liveResult.rows[1].mark, "unreviewed");
});

/* 13. 仍离线时合并不丢登记时间，且去重 */
test("持续离线：待补登记时间保留且不重复", () => {
  const previous = [{ paraRef: "p1", reason: "old", since: 111 }];
  const cached = { sheet: sheet([]), fetchedAt: T0 };
  const offlineResult = reconcileParagraphs([block("p1", T0 - day)], { live: null, cached });
  const merged = mergeBackfillQueue(previous, offlineResult, T0 + 5 * day);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].since, 111);
});

console.log(`\n${passed} 项断言全部通过`);
