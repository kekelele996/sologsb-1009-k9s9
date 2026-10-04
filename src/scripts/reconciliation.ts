// 审校室对账核心逻辑（纯函数，不依赖 DOM / localStorage，便于测试）。
//
// 对账规则（来自需求）：
// - 改写工作台与审校室各管各的数据，两边只靠「段落编号」和「出具时间」对账。
// - 导出标记只认审校单结论：
//     通过 → 已复核；退回 → 照旧导出并标「待改」；无结论 → 未复核。
// - 本地复核结果不作数：本地已审过但审校单没给结论，仍记未复核。
// - 段落改动后须由审校室重新确认；结论出具时间早于段落最近内容改动时间的
//   「通过」不能再算通过（记未复核、需重新确认）。「退回」仍按待改导出。
// - 审校单一时取不到：导出照做，缺对账依据的段落进待补清单，
//   连接恢复后按段落编号补回结论；改写稿与批注不受影响。

export type ReviewDecision = "pass" | "return";
export type ReconcileSource = "live" | "unavailable";
export type ExportMark = "reviewed" | "pending-revision" | "unreviewed";

export interface ReviewSheetItem {
  /** 段落编号，对账主键之一 */
  paraRef: string;
  decision: ReviewDecision;
  /** 该条结论的出具时间（ms epoch），对账主键之二 */
  issuedAt: number;
}

export interface ReviewSheet {
  sheetNo: string;
  /** 整份审校单的出具时间（ms epoch） */
  issuedAt: number;
  items: ReviewSheetItem[];
}

export interface CachedSheet {
  sheet: ReviewSheet;
  /** 本地最近一次成功取到审校单的时间 */
  fetchedAt: number;
}

export interface ReconcileBlock {
  paraRef: string;
  /** 段落内容最近一次改动时间；改原因、批注、本地复核状态不刷新此值 */
  contentUpdatedAt: number;
  /** 工作台本地复核结果（仅供展示，导出不认） */
  localReviewed?: boolean;
}

export interface ReconcileRow {
  paraRef: string;
  mark: ExportMark;
  decision: ReviewDecision | null;
  /** 采用的结论出具时间 */
  decisionIssuedAt: number | null;
  /** 采用的审校单出具时间 */
  sheetIssuedAt: number | null;
  /** 结论是否取自缓存（审校室当前不可用） */
  fromCache: boolean;
  /** 结论出具时间早于段落最近改动，已失效 */
  stale: boolean;
  /** 审校室不可用且缺少可用结论，已进待补清单 */
  pendingBackfill: boolean;
  /** 段落改动后需审校室重新确认 */
  needsReconfirm: boolean;
  note: string;
}

export interface ReconcileResult {
  source: ReconcileSource;
  /** 本次导出实际采用的审校单（实时单或缓存单；都没有则为 null） */
  sheet: ReviewSheet | null;
  cachedFetchedAt: number | null;
  rows: ReconcileRow[];
  /** 待补清单：等连接恢复后按段落编号补结论 */
  backfill: ReconcileRow[];
  /** 需请审校室重新确认的段落（改动晚于结论） */
  reconfirm: ReconcileRow[];
  reviewedCount: number;
  returnedCount: number;
  unreviewedCount: number;
}

export const MARK_LABEL: Record<ExportMark, string> = {
  reviewed: "已复核",
  "pending-revision": "待改",
  unreviewed: "未复核",
};

export const DECISION_LABEL: Record<ReviewDecision, string> = {
  pass: "通过",
  return: "退回",
};

interface ReconcileOptions {
  /** 实时取到的审校单；取不到传 null */
  live: ReviewSheet | null;
  /** 本地缓存的上一份审校单 */
  cached: CachedSheet | null;
  now?: number;
}

/**
 * 按段落编号把改写稿与审校单逐条对账，得到每个段落的导出复核标记。
 */
export function reconcileParagraphs(
  blocks: ReconcileBlock[],
  options: ReconcileOptions,
): ReconcileResult {
  const now = options.now ?? Date.now();
  const liveAvailable = options.live !== null;
  const source: ReconcileSource = liveAvailable ? "live" : "unavailable";
  const sheet = options.live ?? options.cached?.sheet ?? null;
  const itemByPara = new Map(sheet?.items.map((item) => [item.paraRef, item]) ?? []);

  const rows: ReconcileRow[] = blocks.map((block) => {
    const item = itemByPara.get(block.paraRef) ?? null;

    if (!item) {
      return emptyConclusionRow(block, source === "unavailable");
    }

    // 结论出具时间必须不早于段落最近内容改动时间，否则结论已被后续改动作废。
    const stale = item.issuedAt < block.contentUpdatedAt;

    if (item.decision === "pass") {
      if (!stale) {
        return {
          paraRef: block.paraRef,
          mark: "reviewed",
          decision: "pass",
          decisionIssuedAt: item.issuedAt,
          sheetIssuedAt: sheet!.issuedAt,
          fromCache: !liveAvailable,
          stale: false,
          pendingBackfill: false,
          needsReconfirm: false,
          note: liveAvailable
            ? "审校单结论：通过"
            : "审校室暂不可用，按缓存审校单的通过结论标记，恢复后补对账",
        };
      }
      // 晚于（实为：段落改动晚于）审校单出具时间的通过结论不再算通过。
      return {
        paraRef: block.paraRef,
        mark: "unreviewed",
        decision: "pass",
        decisionIssuedAt: item.issuedAt,
        sheetIssuedAt: sheet!.issuedAt,
        fromCache: !liveAvailable,
        stale: true,
        // 离线且结论已失效时，恢复后必须补结论，进待补清单。
        pendingBackfill: !liveAvailable,
        needsReconfirm: true,
        note: "段落改动晚于审校单通过结论，需审校室重新确认",
      };
    }

    // 退回：无论结论是否早于最新改动，都照旧导出并标出待改。
    return {
      paraRef: block.paraRef,
      mark: "pending-revision",
      decision: "return",
      decisionIssuedAt: item.issuedAt,
      sheetIssuedAt: sheet!.issuedAt,
      fromCache: !liveAvailable,
      stale,
      pendingBackfill: !liveAvailable && stale,
      needsReconfirm: stale,
      note: stale
        ? "审校单结论：退回；该结论早于段落最近改动，仍按待改导出并请审校室复核"
        : liveAvailable
          ? "审校单结论：退回，按待改导出"
          : "审校室暂不可用，按缓存审校单的退回结论标待改，恢复后补对账",
    };
  });

  const backfill = rows.filter((row) => row.pendingBackfill);
  const reconfirm = rows.filter((row) => row.needsReconfirm);
  void now;

  return {
    source,
    sheet,
    cachedFetchedAt: liveAvailable ? null : (options.cached?.fetchedAt ?? null),
    rows,
    backfill,
    reconfirm,
    reviewedCount: rows.filter((row) => row.mark === "reviewed").length,
    returnedCount: rows.filter((row) => row.mark === "pending-revision").length,
    unreviewedCount: rows.filter((row) => row.mark === "unreviewed").length,
  };
}

function emptyConclusionRow(block: ReconcileBlock, unavailable: boolean): ReconcileRow {
  const localNote = block.localReviewed ? "本地已复核但审校单未给结论，仍记未复核；" : "";
  if (unavailable) {
    return {
      paraRef: block.paraRef,
      mark: "unreviewed",
      decision: null,
      decisionIssuedAt: null,
      sheetIssuedAt: null,
      fromCache: false,
      stale: false,
      pendingBackfill: true,
      needsReconfirm: false,
      note: `${localNote}审校单暂时取不到，进待补清单，连接恢复后按段落编号补回结论`,
    };
  }
  return {
    paraRef: block.paraRef,
    mark: "unreviewed",
    decision: null,
    decisionIssuedAt: null,
    sheetIssuedAt: null,
    fromCache: false,
    stale: false,
    pendingBackfill: false,
    needsReconfirm: false,
    note: `${localNote}审校单尚未给该段结论`,
  };
}

/** 待补清单的持久化形状（只存最小信息，改写稿和批注不掺进来）。 */
export interface BackfillEntry {
  paraRef: string;
  reason: string;
  since: number;
}

export function toBackfillEntries(result: ReconcileResult, now = Date.now()): BackfillEntry[] {
  return result.backfill.map((row) => ({ paraRef: row.paraRef, reason: row.note, since: now }));
}

/**
 * 连接恢复、成功取到新审校单后合并待补清单：
 * 仍在新对账结果待补列表里的段落保留最早登记时间，其余视为已补回并移除。
 * 实时取单成功时，新结果不会产生待补项，因此队列会被整体清空。
 */
export function mergeBackfillQueue(
  previous: BackfillEntry[],
  result: ReconcileResult,
  now = Date.now(),
): BackfillEntry[] {
  const current = new Map(toBackfillEntries(result, now).map((entry) => [entry.paraRef, entry]));
  const merged: BackfillEntry[] = [];
  for (const entry of previous) {
    const fresh = current.get(entry.paraRef);
    if (fresh) merged.push({ ...fresh, since: entry.since });
    current.delete(entry.paraRef);
  }
  for (const fresh of current.values()) merged.push(fresh);
  return merged;
}
