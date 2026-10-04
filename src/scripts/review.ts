// 审校室 · 审校单与对账
// ---------------------------------------------------------------
// 改写工作台管内容块和改写原因；审校室管审校单，给每段写“通过 / 退回”。
// 两边靠【段落编号 + 审校单出具时间】对账。
// 当前先不接后端，审校室出单由本地模拟；审校单单独存 localStorage，
// 补回结论只动审校单，不影响改写稿和批注。

export type ReviewDecisionKind = "approved" | "rejected";

export interface ReviewDecision {
  paragraphNo: number; // 段落编号（与改写稿对账用）
  decision: ReviewDecisionKind; // 通过 / 退回
  decidedAt: string; // 结论时间（ISO）
  note: string; // 退回原因 / 备注
}

export interface ReviewSheet {
  schema: 1;
  source: string; // 出具单位，如“学校审校室”
  issueTime: string; // 出具时间（对账基准）
  items: ReviewDecision[];
}

// 对账结论：
//  reviewed  审校单通过且内容未改动 -> 已复核
//  rejected  审校单退回 -> 照旧导出并标出待改
//  stale     审校单出具后段落被改动 -> 通过结论失效，需重新确认
//  missing   审校单未出具或缺少该段结论 -> 未复核，进待补清单
export type ReconcileState = "reviewed" | "rejected" | "stale" | "missing";

export interface BlockReviewState {
  state: ReconcileState;
  decision?: ReviewDecision;
  reason: string;
}

export interface ReviewBlockLike {
  paragraphNo: number;
  type: string;
  text: string;
  accessibleText: string;
  imageAlt?: string;
  headingLevel?: number;
}

export interface ReviewFetchResult {
  ok: boolean;
  offline?: boolean;
  sheet?: ReviewSheet;
}

const REVIEW_SHEET_KEY = "sologsb-1009-review-sheet-v1";

export function loadReviewSheet(): ReviewSheet | null {
  try {
    const raw = localStorage.getItem(REVIEW_SHEET_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReviewSheet;
    if (parsed.schema === 1 && Array.isArray(parsed.items)) return parsed;
  } catch {
    // 审校单损坏时当作未出具，不影响改写稿。
  }
  return null;
}

export function saveReviewSheet(sheet: ReviewSheet | null) {
  if (sheet) localStorage.setItem(REVIEW_SHEET_KEY, JSON.stringify(sheet));
  else localStorage.removeItem(REVIEW_SHEET_KEY);
}

// 模拟审校室网络取单：离线或后端不可达时返回 offline，由调用方走待补流程。
export async function fetchReviewSheet(
  blocks: ReviewBlockLike[],
  opts: { online: boolean; now?: number; delayMs?: number },
): Promise<ReviewFetchResult> {
  await new Promise((resolve) => setTimeout(resolve, opts.delayMs ?? 420));
  if (!opts.online) return { ok: false, offline: true };

  const at = new Date(opts.now ?? Date.now()).toISOString();
  const items: ReviewDecision[] = blocks.map((block) => {
    const reject = rejectReasonFor(block);
    if (reject) {
      return { paragraphNo: block.paragraphNo, decision: "rejected", decidedAt: at, note: reject };
    }
    return { paragraphNo: block.paragraphNo, decision: "approved", decidedAt: at, note: "符合无障碍要求，通过" };
  });

  return {
    ok: true,
    sheet: { schema: 1, source: "学校审校室", issueTime: at, items },
  };
}

// 审校室退回尺度：只退回“必须修复”的无障碍问题，其余通过。
function rejectReasonFor(block: ReviewBlockLike): string | null {
  if (block.type === "image" && !(block.imageAlt ?? block.accessibleText).trim()) {
    return "图片缺少替代文本，读屏用户无法获取图中信息";
  }
  if (block.type === "link") {
    const label = (block.accessibleText || block.text).trim();
    if (/^(点击这里|这里|链接|更多|here|click here|read more)$/i.test(label)) {
      return "链接文案未说明目的，单独朗读时无法知道会前往哪里";
    }
  }
  return null;
}

export function reconcileBlock(
  block: { paragraphNo: number; lastModifiedAt: string },
  sheet: ReviewSheet | null,
): BlockReviewState {
  if (!sheet) return { state: "missing", reason: "审校单未出具，缺对账" };
  const decision = sheet.items.find((item) => item.paragraphNo === block.paragraphNo);
  if (!decision) return { state: "missing", reason: "审校单缺少该段结论" };

  const modifiedAt = Date.parse(block.lastModifiedAt);
  const decidedAt = Date.parse(decision.decidedAt);
  const issuedAt = Date.parse(sheet.issueTime);
  // 改动过的段落要请审校室重新确认：内容在结论之后、或审校单出具之后被改动，
  // 原先的通过结论不再算数。
  const changedAfterReview =
    Number.isFinite(modifiedAt) && (modifiedAt > decidedAt || modifiedAt > issuedAt);

  if (changedAfterReview) {
    return { state: "stale", decision, reason: "该段在审校单出具后有改动，结论需重新确认" };
  }
  if (decision.decision === "approved") {
    return { state: "reviewed", decision, reason: "审校单通过" };
  }
  return { state: "rejected", decision, reason: decision.note || "审校单退回，待修改" };
}

export interface ReconcileSummary {
  results: Array<{ block: { paragraphNo: number; id: string } } & BlockReviewState>;
  reviewed: number;
  rejected: number;
  stale: number;
  missing: number;
  missingParagraphs: number[];
}

export function reconcileAll(
  blocks: Array<{ id: string; paragraphNo: number; lastModifiedAt: string }>,
  sheet: ReviewSheet | null,
): ReconcileSummary {
  const results = blocks.map((block) => ({ block, ...reconcileBlock(block, sheet) }));
  return {
    results,
    reviewed: results.filter((r) => r.state === "reviewed").length,
    rejected: results.filter((r) => r.state === "rejected").length,
    stale: results.filter((r) => r.state === "stale").length,
    missing: results.filter((r) => r.state === "missing").length,
    missingParagraphs: results.filter((r) => r.state === "missing").map((r) => r.block.paragraphNo),
  };
}

export function formatIssueTime(iso: string | null): string {
  if (!iso) return "尚未出具";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "尚未出具";
  return d.toLocaleString();
}
