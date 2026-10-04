// 审校室侧的本地模拟：审校单存在审校室自己的存储里，与改写稿完全分开。
// 真实接入时把 fetchReviewSheet 换成对审校室服务的请求即可，调用方不变。

import type {
  BackfillEntry,
  ReviewDecision,
  ReviewSheet,
  ReviewSheetItem,
} from "./reconciliation";

const ROOM_KEY = "sologsb-1009-review-room-v1";
const LEDGER_KEY = "sologsb-1009-reconcile-ledger-v1";
const FETCH_DELAY_MS = 420;

interface ReviewRoomState {
  sheet: ReviewSheet;
  /** 审校室连接开关，关掉即模拟“审校单一时取不到” */
  offline: boolean;
}

interface ReconcileLedger {
  cachedSheet: { sheet: ReviewSheet; fetchedAt: number } | null;
  backfillQueue: BackfillEntry[];
  lastLiveFetchAt: number | null;
}

export const fixedSeedTimes = {
  sheetIssuedAt: Date.UTC(2026, 8, 20, 2, 0, 0), // 2026-09-20 10:00 (UTC+8)
  oldPassIssuedAt: Date.UTC(2026, 8, 18, 2, 0, 0), // 2026-09-18 10:00
  stalePassIssuedAt: Date.UTC(2026, 8, 25, 2, 0, 0), // 2026-09-25 10:00
  blockP3EditedAt: Date.UTC(2026, 9, 2, 2, 0, 0), // 2026-10-02 10:00，改动晚于 9/25 通过
  nowBase: Date.UTC(2026, 9, 4, 4, 0, 0), // 2026-10-04 12:00
};

export function seedReviewSheet(): ReviewSheet {
  const t = fixedSeedTimes;
  const items: ReviewSheetItem[] = [
    { paraRef: "block-h1", decision: "pass", issuedAt: t.sheetIssuedAt },
    { paraRef: "block-p1", decision: "pass", issuedAt: t.sheetIssuedAt },
    { paraRef: "block-h2", decision: "pass", issuedAt: t.sheetIssuedAt },
    { paraRef: "block-img", decision: "return", issuedAt: t.sheetIssuedAt },
    { paraRef: "block-p2", decision: "pass", issuedAt: t.oldPassIssuedAt },
    { paraRef: "block-link", decision: "pass", issuedAt: t.sheetIssuedAt },
    { paraRef: "block-h3", decision: "pass", issuedAt: t.sheetIssuedAt },
    // p3 审校室 9/25 给过通过，但段落 10/2 又改过 → 通过失效，需重新确认
    { paraRef: "block-p3", decision: "pass", issuedAt: t.stalePassIssuedAt },
    // p4 本地已复核，但审校单始终未给结论
  ];
  return {
    sheetNo: "SC-2026-FALL-0317",
    issuedAt: t.sheetIssuedAt,
    items,
  };
}

function loadRoom(): ReviewRoomState {
  try {
    const stored = JSON.parse(localStorage.getItem(ROOM_KEY) ?? "") as ReviewRoomState;
    if (stored?.sheet?.items && typeof stored.offline === "boolean") return stored;
  } catch {
    // 忽略损坏数据，回到内置审校单。
  }
  const initial = { sheet: seedReviewSheet(), offline: false };
  localStorage.setItem(ROOM_KEY, JSON.stringify(initial));
  return initial;
}

function saveRoom(state: ReviewRoomState) {
  localStorage.setItem(ROOM_KEY, JSON.stringify(state));
}

function loadLedger(): ReconcileLedger {
  try {
    const stored = JSON.parse(localStorage.getItem(LEDGER_KEY) ?? "") as ReconcileLedger;
    if (stored && Array.isArray(stored.backfillQueue)) {
      return {
        cachedSheet: stored.cachedSheet ?? null,
        backfillQueue: stored.backfillQueue,
        lastLiveFetchAt: stored.lastLiveFetchAt ?? null,
      };
    }
  } catch {
    // 忽略损坏数据。
  }
  return { cachedSheet: null, backfillQueue: [], lastLiveFetchAt: null };
}

function saveLedger(ledger: ReconcileLedger) {
  localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
}

/** 向审校室取单：连接断开时失败；成功则刷新本地缓存。 */
export async function fetchReviewSheet(): Promise<ReviewSheet> {
  await new Promise((resolve) => setTimeout(resolve, FETCH_DELAY_MS));
  const room = loadRoom();
  if (room.offline) throw new Error("REVIEW_ROOM_UNAVAILABLE");
  const ledger = loadLedger();
  ledger.cachedSheet = { sheet: structuredClone(room.sheet), fetchedAt: Date.now() };
  ledger.lastLiveFetchAt = Date.now();
  saveLedger(ledger);
  return structuredClone(room.sheet);
}

export function getCachedSheet() {
  return loadLedger().cachedSheet;
}

export function getLedgerState(): { cachedSheet: ReconcileLedger["cachedSheet"]; backfillQueue: BackfillEntry[]; lastLiveFetchAt: number | null } {
  const ledger = loadLedger();
  return {
    cachedSheet: ledger.cachedSheet,
    backfillQueue: ledger.backfillQueue,
    lastLiveFetchAt: ledger.lastLiveFetchAt,
  };
}

export function saveBackfillQueue(queue: BackfillEntry[]) {
  const ledger = loadLedger();
  ledger.backfillQueue = queue;
  saveLedger(ledger);
}

/* ---------- 审校室模拟面板用的管理操作（真实系统中在审校室完成） ---------- */

export function getReviewRoomState(): ReviewRoomState {
  return loadRoom();
}

export function setReviewRoomOffline(offline: boolean) {
  const room = loadRoom();
  room.offline = offline;
  saveRoom(room);
}

export function updateReviewItem(paraRef: string, decision: ReviewDecision, issuedAt: number) {
  const room = loadRoom();
  const existing = room.sheet.items.find((item) => item.paraRef === paraRef);
  if (existing) {
    existing.decision = decision;
    existing.issuedAt = issuedAt;
  } else {
    room.sheet.items.push({ paraRef, decision, issuedAt });
  }
  saveRoom(room);
}

export function removeReviewItem(paraRef: string) {
  const room = loadRoom();
  room.sheet.items = room.sheet.items.filter((item) => item.paraRef !== paraRef);
  saveRoom(room);
}

export function setSheetMeta(sheetNo: string) {
  const room = loadRoom();
  room.sheet.sheetNo = sheetNo.trim() || room.sheet.sheetNo;
  saveRoom(room);
}

/** 审校室重新出具一份审校单：整单出具时间变为当前时刻，未逐条改时间的结论沿用旧时间。 */
export function reissueSheet(now = Date.now()): ReviewSheet {
  const room = loadRoom();
  room.sheet = { ...room.sheet, issuedAt: now };
  saveRoom(room);
  return structuredClone(room.sheet);
}
