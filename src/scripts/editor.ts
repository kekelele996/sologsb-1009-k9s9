import "@shoelace-style/shoelace/dist/shoelace.js";
import {
  MARK_LABEL,
  mergeBackfillQueue,
  reconcileParagraphs,
  toBackfillEntries,
  type ExportMark,
  type ReconcileResult,
  type ReviewDecision,
  type ReviewSheet,
} from "./reconciliation";
import {
  fetchReviewSheet,
  fixedSeedTimes,
  getCachedSheet,
  getLedgerState,
  getReviewRoomState,
  reissueSheet,
  removeReviewItem,
  saveBackfillQueue,
  setReviewRoomOffline,
  setSheetMeta,
  updateReviewItem,
} from "./reviewRoom";

type BlockType = "heading" | "paragraph" | "image" | "link";
type ReviewStatus = "pending" | "approved" | "needs-work";
type Severity = "error" | "warning" | "info";

interface CommentReply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

interface CommentItem {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: CommentReply[];
}

interface ContentBlock {
  id: string;
  /** 段落编号：与审校室对账的稳定主键，导入或新增时确定，不随编辑顺序变 */
  paraRef: string;
  type: BlockType;
  text: string;
  accessibleText: string;
  headingLevel?: number;
  imageSrc?: string;
  imageAlt?: string;
  linkHref?: string;
  changeReason: string;
  /** 仅为工作台本地复核状态；导出的复核标记只认审校单结论 */
  reviewStatus: ReviewStatus;
  /** 段落内容（原文/无障碍文本/图注/链接/层级）最近改动时间，改原因与批注不刷新 */
  contentUpdatedAt: number;
  comments: CommentItem[];
}

interface GlossaryTerm {
  id: string;
  source: string;
  preferred: string;
  note: string;
}

interface VersionSnapshot {
  id: string;
  label: string;
  createdAt: string;
  blocks: ContentBlock[];
  glossary: GlossaryTerm[];
}

interface ChapterProject {
  id: string;
  title: string;
  subject: string;
  grade: string;
  blocks: ContentBlock[];
  glossary: GlossaryTerm[];
  versions: VersionSnapshot[];
  updatedAt: string;
}

interface AccessibilityIssue {
  id: string;
  blockId: string;
  type: "heading" | "link" | "image" | "glossary" | "sentence";
  severity: Severity;
  title: string;
  detail: string;
  suggestion: string;
}

const STORAGE_KEY = "sologsb-1009-accessible-textbook-v1";
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function createSeedProject(): ChapterProject {
  const blocks: ContentBlock[] = [
    {
      id: "block-h1",
      paraRef: "block-h1",
      type: "heading",
      headingLevel: 1,
      text: "第三章 水循环与城市",
      accessibleText: "第三章 水循环与城市",
      changeReason: "",
      reviewStatus: "approved",
      contentUpdatedAt: fixedSeedTimes.sheetIssuedAt - 86_400_000,
      comments: [],
    },
    {
      id: "block-p1",
      paraRef: "block-p1",
      type: "paragraph",
      text: "城市中的水并非取之不尽，由于其会通过蒸发、降水以及地表径流等若干复杂过程在自然界中持续循环，因此理解这些过程对于建设具有韧性的城市具有十分重要的意义。",
      accessibleText: "城市里的水会不断循环。它经过蒸发、降水并沿地面流动。了解这些过程，可以帮助我们建设更能适应变化的城市。",
      changeReason: "拆分长句，把抽象表述改为更直接的说明。",
      reviewStatus: "pending",
      contentUpdatedAt: fixedSeedTimes.sheetIssuedAt - 86_400_000,
      comments: [],
    },
    {
      id: "block-h2",
      paraRef: "block-h2",
      type: "heading",
      headingLevel: 2,
      text: "一、水从哪里来",
      accessibleText: "一、水从哪里来",
      changeReason: "保留原章节结构。",
      reviewStatus: "approved",
      contentUpdatedAt: fixedSeedTimes.sheetIssuedAt - 86_400_000,
      comments: [],
    },
    {
      id: "block-img",
      paraRef: "block-img",
      type: "image",
      text: "图 3-1 城市水循环示意",
      imageSrc: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='420'%3E%3Crect width='800' height='420' fill='%23dcecf3'/%3E%3Ccircle cx='650' cy='85' r='45' fill='%23f4c95d'/%3E%3Cpath d='M0 300 Q180 240 340 300 T800 280 V420 H0Z' fill='%2389b7d0'/%3E%3Cpath d='M130 285 Q220 170 330 285' fill='none' stroke='%233a7c9e' stroke-width='12'/%3E%3C/svg%3E",
      imageAlt: "",
      accessibleText: "",
      changeReason: "",
      reviewStatus: "needs-work",
      contentUpdatedAt: fixedSeedTimes.sheetIssuedAt - 86_400_000,
      comments: [],
    },
    {
      id: "block-p2",
      paraRef: "block-p2",
      type: "paragraph",
      text: "当太阳照射到水面时，水会受热变成水蒸气升到空中。水蒸气冷却后形成云，再以雨或雪的形式落回地面。",
      accessibleText: "太阳照在水面上，水会变成水蒸气升到空中。水蒸气冷却后变成云，最后以雨或雪落回地面。",
      changeReason: "使用较短句子，并明确每个步骤的先后顺序。",
      reviewStatus: "approved",
      // 内容 9/17 定稿，审校室 9/18 给出通过：结论晚于改动，仍然有效。
      contentUpdatedAt: fixedSeedTimes.oldPassIssuedAt - 86_400_000,
      comments: [],
    },
    {
      id: "block-link",
      paraRef: "block-link",
      type: "link",
      text: "点击这里",
      linkHref: "/resources/water-cycle",
      accessibleText: "打开水循环互动实验",
      changeReason: "改为说明链接目标的独立文案。",
      reviewStatus: "pending",
      contentUpdatedAt: fixedSeedTimes.sheetIssuedAt - 86_400_000,
      comments: [],
    },
    {
      id: "block-h3",
      paraRef: "block-h3",
      type: "heading",
      headingLevel: 3,
      text: "雨水花园怎样工作",
      accessibleText: "雨水花园怎样工作",
      changeReason: "",
      reviewStatus: "approved",
      contentUpdatedAt: fixedSeedTimes.sheetIssuedAt - 86_400_000,
      comments: [],
    },
    {
      id: "block-p3",
      paraRef: "block-p3",
      type: "paragraph",
      text: "雨水花园利用土壤和植物的共同作用暂时储存雨水，同时通过下渗补给地下水，并在降雨较集中时减轻城市排水管道所承受的压力。",
      accessibleText: "雨水花园用土壤和植物暂时存住雨水。雨水还会慢慢渗入地下，补充地下水。雨很大时，它可以减轻排水管的压力。",
      changeReason: "把并列成分拆成短句，减少专业术语密度。",
      reviewStatus: "approved",
      // 10/2 又改过：审校单 9/25 的通过结论早于本次改动，导出不能再算通过。
      contentUpdatedAt: fixedSeedTimes.blockP3EditedAt,
      comments: [],
    },
    {
      id: "block-p4",
      paraRef: "block-p4",
      type: "paragraph",
      text: "为了减少暴雨时路面积水，城市可以在道路两侧设置透水铺装，并让雨水通过管道汇入附近的湿地。",
      accessibleText: "为了减少下大雨时路上的积水，道路两边可以铺透水砖。雨水顺着管道流入附近的湿地。",
      changeReason: "补充动作主体，把并列措施拆成两句。",
      // 本地已复核，但审校单还没给这段结论 → 导出仍记未复核。
      reviewStatus: "approved",
      contentUpdatedAt: fixedSeedTimes.sheetIssuedAt - 3_600_000,
      comments: [],
    },
  ];

  return {
    id: "accessible-textbook-1009",
    title: "科学（五年级下册）·无障碍改写稿",
    subject: "科学",
    grade: "五年级",
    blocks,
    glossary: [
      { id: "term-1", source: "水循环", preferred: "水循环", note: "全书统一使用" },
      { id: "term-2", source: "地表径流", preferred: "沿地面流动的水", note: "首次出现时使用通俗解释" },
      { id: "term-3", source: "下渗", preferred: "渗入地下", note: "避免单独使用专业词" },
    ],
    versions: [],
    updatedAt: new Date().toISOString(),
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseImportedChapter(input: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  lines.forEach((line, index) => {
    const paraRef = `para-${String(index + 1).padStart(3, "0")}`;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(blankBlock("heading", heading[2], paraRef, { headingLevel: heading[1].length }));
      return;
    }
    const image = /^!\[([^\]]*)\]\(([^)]+)\)(?:\s+(.+))?$/.exec(line);
    if (image) {
      blocks.push(blankBlock("image", image[3] || "未命名图片", paraRef, { imageSrc: image[2], imageAlt: image[1] }));
      return;
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(line);
    if (link) {
      blocks.push(blankBlock("link", link[1], paraRef, { linkHref: link[2] }));
      return;
    }
    blocks.push(blankBlock("paragraph", line, paraRef));
  });
  return blocks.length ? blocks : [blankBlock("paragraph", input.trim() || "请输入章节内容", "para-001")];
}

function blankBlock(type: BlockType, text: string, paraRef: string, extra: Partial<ContentBlock> = {}): ContentBlock {
  return {
    id: uid("block"),
    paraRef,
    type,
    text,
    accessibleText: type === "image" ? extra.imageAlt ?? "" : text,
    changeReason: "",
    reviewStatus: "pending",
    contentUpdatedAt: Date.now(),
    comments: [],
    ...extra,
  };
}

function sentenceLength(text: string) {
  const normalized = text.replace(/\s+/g, "");
  return /[A-Za-z]/.test(text) ? text.trim().split(/\s+/).length : normalized.length;
}

function analyze(project: ChapterProject): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];
  let lastHeading = 0;
  for (const block of project.blocks) {
    if (block.type === "heading") {
      const level = block.headingLevel ?? 2;
      if (lastHeading && level > lastHeading + 1) {
        issues.push({
          id: `heading-${block.id}`,
          blockId: block.id,
          type: "heading",
          severity: "error",
          title: "标题层级跳跃",
          detail: `从 H${lastHeading} 直接到 H${level}，读屏用户会失去清晰的章节结构。`,
          suggestion: `改为 H${lastHeading + 1}，或补上中间的上级标题。`,
        });
      }
      lastHeading = level;
    }
    if (block.type === "image" && !(block.imageAlt ?? block.accessibleText).trim()) {
      issues.push({
        id: `image-${block.id}`,
        blockId: block.id,
        type: "image",
        severity: "error",
        title: "图片缺少替代文本",
        detail: "视觉用户能看到的图表信息，读屏用户目前无法获得。",
        suggestion: "说明图中主体、变化和结论；纯装饰图片应标记为空替代文本。",
      });
    }
    if (block.type === "link") {
      const label = block.accessibleText || block.text;
      if (/^(点击这里|这里|链接|更多|here|click here|read more)$/i.test(label.trim())) {
        issues.push({
          id: `link-${block.id}`,
          blockId: block.id,
          type: "link",
          severity: "error",
          title: "链接文案缺少目的",
          detail: `“${label}”单独朗读时无法说明会前往哪里。`,
          suggestion: "改成“打开水循环互动实验”等可独立理解的文案。",
        });
      }
    }
    const text = block.type === "image" ? block.text : block.text;
    const sentences = text.split(/(?<=[。！？!?])\s*/).filter(Boolean);
    for (const [index, sentence] of sentences.entries()) {
      if (sentenceLength(sentence) > (/[A-Za-z]/.test(sentence) ? 28 : 42)) {
        issues.push({
          id: `sentence-${block.id}-${index}`,
          blockId: block.id,
          type: "sentence",
          severity: "warning",
          title: "句子过长",
          detail: `该句约 ${sentenceLength(sentence)} ${/[A-Za-z]/.test(sentence) ? "个词" : "个字"}，一次理解的信息较多。`,
          suggestion: "按动作或因果关系拆成 2—3 个短句。",
        });
      }
    }
    const source = `${block.text} ${block.accessibleText}`;
    for (const term of project.glossary) {
      if (source.includes(term.source) && block.accessibleText && !block.accessibleText.includes(term.preferred)) {
        issues.push({
          id: `term-${block.id}-${term.id}`,
          blockId: block.id,
          type: "glossary",
          severity: "info",
          title: `术语“${term.source}”尚未统一`,
          detail: `全书建议表述为“${term.preferred}”。${term.note}`,
          suggestion: `将无障碍文本调整为“${term.preferred}”。`,
        });
      }
    }
  }
  return issues;
}

function simplifyText(input: string, glossary: GlossaryTerm[]) {
  let result = input
    .replaceAll("由于其", "因为")
    .replaceAll("因此", "所以")
    .replaceAll("具有十分重要的意义", "很重要")
    .replaceAll("利用", "使用")
    .replaceAll("共同作用", "一起作用")
    .replaceAll("暂时储存", "暂时存住")
    .replaceAll("所承受的压力", "受到的压力")
    .replace(/([^。！？]{38,}?)[，、]([^。！？]{12,}?[。！？])/g, "$1。$2");
  for (const term of glossary) {
    if (result.includes(term.source)) result = result.replaceAll(term.source, term.preferred);
  }
  result = result
    .split(/(?<=[。！？!?])\s*/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .join("\n");
  return result;
}

function blockRole(block: ContentBlock) {
  if (block.type === "heading") return `H${block.headingLevel ?? 2} 标题`;
  if (block.type === "image") return "图片 / 替代文本";
  if (block.type === "link") return "链接";
  return "正文段落";
}

function renderReconcileChip(row: ReconcileResult["rows"][number] | undefined) {
  if (!row) return `<span class="reconcile-chip mark-unreviewed">未对账</span>`;
  const decision = row.decision === "pass" ? "通过" : row.decision === "return" ? "退回" : "无结论";
  return `<div class="reconcile-chip-wrap">
    <span class="reconcile-chip mark-${row.mark}${row.pendingBackfill ? " pending-backfill" : ""}">${MARK_LABEL[row.mark]}</span>
    <small>${decision}${row.decisionIssuedAt ? ` · 出具 ${formatStamp(row.decisionIssuedAt)}` : ""}${row.fromCache ? " · 缓存" : ""}</small>
    <small class="reconcile-note-text">${escapeHtml(row.note)}</small>
  </div>`;
}

function severityLabel(severity: Severity) {
  if (severity === "error") return "必须修复";
  if (severity === "warning") return "建议优化";
  return "一致性提醒";
}

function formatStamp(ms: number | null) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

function markBadgeHtml(mark: ExportMark, note: string) {
  return `<span class="review-mark review-mark-${mark}" role="status" aria-label="复核标记：${MARK_LABEL[mark]}；${escapeHtml(note)}" title="${escapeHtml(note)}">${MARK_LABEL[mark]}</span>`;
}

function exportHtml(project: ChapterProject, result: ReconcileResult) {
  const rowByPara = new Map(result.rows.map((row) => [row.paraRef, row]));
  const body = project.blocks.map((block) => {
    const row = rowByPara.get(block.paraRef);
    const badge = row ? markBadgeHtml(row.mark, row.note) : "";
    if (block.type === "heading") {
      const level = Math.min(6, Math.max(1, block.headingLevel ?? 2));
      return `<h${level}>${escapeHtml(block.accessibleText || block.text)}${badge}</h${level}>`;
    }
    if (block.type === "image") {
      return `<figure><img src="${escapeHtml(block.imageSrc ?? "")}" alt="${escapeHtml(block.imageAlt || block.accessibleText)}"><figcaption>${escapeHtml(block.text)}${badge}</figcaption></figure>`;
    }
    if (block.type === "link") {
      return `<p><a href="${escapeHtml(block.linkHref ?? "#")}">${escapeHtml(block.accessibleText || block.text)}</a>${badge}</p>`;
    }
    return `<p>${escapeHtml(block.accessibleText || block.text)}${badge}</p>`;
  }).join("\n      ");

  const sourceLine = result.source === "live"
    ? `本次导出已实时对账审校单。`
    : `导出时审校室连接不可用，依据 ${result.sheet ? "本地缓存审校单" : "无缓存审校单"} 标记，缺对账段落已进待补清单。`;

  const tableRows = result.rows.map((row) => {
    const decision = row.decision === "pass" ? "通过" : row.decision === "return" ? "退回" : "无结论";
    return `<tr>
      <td>${escapeHtml(row.paraRef)}</td>
      <td><b>${MARK_LABEL[row.mark]}</b></td>
      <td>${decision}</td>
      <td>${formatStamp(row.decisionIssuedAt)}</td>
      <td>${row.stale ? "结论早于段落改动，已失效" : "—"}</td>
      <td>${escapeHtml(row.note)}</td>
    </tr>`;
  }).join("\n        ");

  const backfillList = result.backfill.length
    ? `<p><strong>待补清单（${result.backfill.length} 段）：</strong>连接恢复后按段落编号补回结论：${result.backfill.map((row) => escapeHtml(row.paraRef)).join("、")}</p>`
    : "<p>无待补段落。</p>";

  const reconfirmList = result.reconfirm.length
    ? `<p><strong>需审校室重新确认（${result.reconfirm.length} 段）：</strong>${result.reconfirm.map((row) => escapeHtml(row.paraRef)).join("、")}（段落改动晚于审校单结论）</p>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(project.title)} · 无障碍版本</title>
  <style>
    :root { font-family: "Noto Sans SC", sans-serif; font-size: 20px; line-height: 1.85; color: #17231f; background: #fffdf7; }
    body { max-width: 760px; margin: 0 auto; padding: 32px 24px 80px; }
    a { color: #075c9d; text-decoration-thickness: 2px; text-underline-offset: 3px; }
    a:focus-visible, [tabindex]:focus-visible { outline: 4px solid #d08a00; outline-offset: 3px; }
    h1, h2, h3, h4, h5, h6 { line-height: 1.4; margin-top: 1.8em; }
    figure { margin: 2em 0; } img { max-width: 100%; height: auto; } figcaption { font-size: .86em; color: #46554f; }
    .skip { position: absolute; left: -9999px; } .skip:focus { position: static; display: inline-block; padding: .5em; background: #fff; }
    .review-mark { display: inline-block; margin-left: .45em; padding: .05em .5em; border-radius: 99px; font-size: .55em; font-weight: 700; vertical-align: middle; line-height: 1.6; }
    .review-mark-reviewed { color: #175c3f; background: #d9f2e4; border: 1px solid #93d4b1; }
    .review-mark-pending-revision { color: #8a2a22; background: #fbe4e1; border: 1px solid #e2a19a; }
    .review-mark-unreviewed { color: #6a5214; background: #fdf1cd; border: 1px solid #dcc06f; }
    .reconcile-note { margin-top: 3em; padding: 18px 20px; border: 1px solid #d8ded9; border-radius: 12px; background: #f7f9f5; font-size: .82em; color: #3d4a45; }
    .reconcile-note h2 { margin: 0 0 .6em; font-size: 1.1em; }
    .reconcile-note table { width: 100%; border-collapse: collapse; margin: .8em 0 1.2em; }
    .reconcile-note th, .reconcile-note td { border: 1px solid #d3dad5; padding: 5px 8px; text-align: left; vertical-align: top; }
    .reconcile-note th { background: #edf2ee; }
  </style>
</head>
<body>
  <a class="skip" href="#main">跳到正文</a>
  <main id="main" tabindex="-1">
      ${body}
      <section class="reconcile-note" aria-label="审校对账说明">
        <h2>审校对账说明</h2>
        <p>${sourceLine}</p>
        <p>审校单编号：${escapeHtml(result.sheet?.sheetNo ?? "（取不到）")}；审校单出具时间：${formatStamp(result.sheet?.issuedAt ?? null)}；导出于 ${formatStamp(Date.now())}。</p>
        <p>已复核 ${result.reviewedCount} 段，待改 ${result.returnedCount} 段，未复核 ${result.unreviewedCount} 段。复核标记只认审校单结论，工作台本地复核不作数。</p>
        ${reconfirmList}
        ${backfillList}
        <table>
          <thead><tr><th>段落编号</th><th>导出标记</th><th>审校结论</th><th>结论出具时间</th><th>时效</th><th>说明</th></tr></thead>
          <tbody>
        ${tableRows}
          </tbody>
        </table>
      </section>
  </main>
</body>
</html>`;
}

function download(filename: string, content: string, type = "text/html;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function loadProject(): ChapterProject {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as { schema: number; project: ChapterProject };
    if (stored.schema === 1 && stored.project?.blocks?.length) {
      const migrated = stored.project;
      // 兼容旧档：补上段落编号与内容改动时间。
      migrated.blocks.forEach((block, index) => {
        if (!block.paraRef) block.paraRef = block.id || `para-${String(index + 1).padStart(3, "0")}`;
        if (typeof block.contentUpdatedAt !== "number") {
          block.contentUpdatedAt = Date.parse(migrated.updatedAt || "") || Date.now();
        }
      });
      return migrated;
    }
  } catch {
    // Fall back to the bundled sample.
  }
  return createSeedProject();
}

const rootElement = document.querySelector<HTMLDivElement>("#app");
if (!rootElement) throw new Error("Application root was not found");
const app: HTMLDivElement = rootElement;

let project = loadProject();
let activeBlockId = project.blocks[0]?.id ?? "";
let activeIssueId = "";
let previewMode: "normal" | "assisted" = "normal";
let selectedVersionId = "";
let showGlossary = false;
let showReviewRoom = false;
let undoStack: ChapterProject[] = [];
let redoStack: ChapterProject[] = [];
let saveTimer = 0;
let reconcileBusy = false;
let reconcileError = false;
let backfillQueue = getLedgerState().backfillQueue;
let reconcileResult: ReconcileResult = computeReconcile(null);

const activeBlock = () => project.blocks.find((block) => block.id === activeBlockId) ?? project.blocks[0];
const issues = () => analyze(project);

function computeReconcile(live: ReviewSheet | null): ReconcileResult {
  return reconcileParagraphs(
    project.blocks.map((block) => ({
      paraRef: block.paraRef,
      contentUpdatedAt: block.contentUpdatedAt,
      localReviewed: block.reviewStatus === "approved",
    })),
    { live, cached: getCachedSheet() },
  );
}

/** 重新对账并刷新页面；拉单成功时顺带消化待补清单。 */
async function syncWithReviewRoom(options: { renderWhenDone?: boolean } = {}) {
  if (reconcileBusy) return;
  reconcileBusy = true;
  render();
  try {
    const live = await fetchReviewSheet();
    reconcileResult = computeReconcile(live);
    reconcileError = false;
    // 连接恢复：仍缺结论的保留登记时间，已补回的按段落编号移除。
    backfillQueue = mergeBackfillQueue(backfillQueue, reconcileResult);
    saveBackfillQueue(backfillQueue);
  } catch {
    // 审校单一时取不到：用缓存照算，导出/展示都不中断。
    reconcileResult = computeReconcile(null);
    reconcileError = true;
    backfillQueue = mergeBackfillQueue(backfillQueue, reconcileResult);
    saveBackfillQueue(backfillQueue);
  } finally {
    reconcileBusy = false;
    if (options.renderWhenDone !== false) render();
  }
}

/** 只依据当前缓存/取单失败状态重算（本地内容刚改动时用，避免无谓取单）。 */
function refreshReconcileFromCache() {
  // 上次对账拿到的是实时单时继续沿用它；否则（离线或从未取单）按 null 走缓存/缺对账分支。
  const liveStillUsable = reconcileResult.source === "live" && !reconcileError;
  reconcileResult = computeReconcile(liveStillUsable ? reconcileResult.sheet : null);
  backfillQueue = mergeBackfillQueue(backfillQueue, reconcileResult);
  saveBackfillQueue(backfillQueue);
}

function saveSoon() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ schema: 1, project }));
  }, 320);
}

function commit(label: string, update: (draft: ChapterProject) => void, renderAfter = true) {
  undoStack = [...undoStack.slice(-49), structuredClone(project)];
  redoStack = [];
  const draft = structuredClone(project);
  update(draft);
  draft.updatedAt = new Date().toISOString();
  project = draft;
  document.documentElement.dataset.lastAction = label;
  saveSoon();
  // 改动可能让旧审校结论失效：即时按缓存重算，导出前仍会重新取实时单。
  refreshReconcileFromCache();
  if (renderAfter) render();
}

function undo() {
  const previous = undoStack.pop();
  if (!previous) return;
  redoStack = [structuredClone(project), ...redoStack].slice(0, 50);
  project = previous;
  if (!project.blocks.some((block) => block.id === activeBlockId)) activeBlockId = project.blocks[0]?.id ?? "";
  saveSoon();
  refreshReconcileFromCache();
  render();
}

function redo() {
  const next = redoStack.shift();
  if (!next) return;
  undoStack = [...undoStack.slice(-49), structuredClone(project)];
  project = next;
  saveSoon();
  refreshReconcileFromCache();
  render();
}

function updateActiveBlock(update: (block: ContentBlock, draft: ChapterProject) => void, label = "修改无障碍文本", renderAfter = true) {
  commit(label, (draft) => {
    const block = draft.blocks.find((item) => item.id === activeBlockId);
    if (block) update(block, draft);
  }, renderAfter);
}

function render() {
  const list = issues();
  const active = activeBlock();
  const activeIssues = list.filter((issue) => issue.blockId === active.id);
  const localApproved = project.blocks.filter((block) => block.reviewStatus === "approved").length;
  const version = project.versions.find((item) => item.id === selectedVersionId) ?? project.versions[0];
  const rowByPara = new Map(reconcileResult.rows.map((row) => [row.paraRef, row]));
  const markOf = (block: ContentBlock) => rowByPara.get(block.paraRef);
  const roomState = getReviewRoomState();

  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand"><span>无障碍</span><b>1009</b></div>
        <div class="title-block">
          <input id="project-title" aria-label="教材名称" value="${escapeHtml(project.title)}" />
          <div class="meta"><span>${escapeHtml(project.subject)}</span><span>${escapeHtml(project.grade)}</span><span class="save-dot">本地自动保存</span></div>
        </div>
        <div class="top-actions">
          <span class="online-pill" title="审校室连接状态">${reconcileBusy ? "审校对账中…" : reconcileError ? (roomState.offline ? "审校室断开" : "审校单取不到") : "审校室已连接"}</span>
          <sl-button size="small" variant="default" ${undoStack.length ? "" : "disabled"} data-action="undo">撤销</sl-button>
          <sl-button size="small" variant="default" ${redoStack.length ? "" : "disabled"} data-action="redo">重做</sl-button>
          <sl-button size="small" variant="default" data-action="glossary">术语表</sl-button>
          <sl-button size="small" variant="default" data-action="review-room">审校室</sl-button>
          <sl-button size="small" variant="primary" data-action="save-version">保存版本</sl-button>
          <sl-button size="small" variant="success" data-action="export" ${reconcileBusy ? "loading" : ""}>导出无障碍 HTML</sl-button>
        </div>
      </header>

      <div class="progress-strip">
        <div class="progress-copy"><b>${reconcileResult.reviewedCount}/${project.blocks.length}</b><span>审校单已复核（本地 ${localApproved}）</span></div>
        <div class="progress-bar"><i style="width:${Math.round((reconcileResult.reviewedCount / Math.max(1, project.blocks.length)) * 100)}%"></i></div>
        <div class="issue-counts">
          <span class="error">${reconcileResult.returnedCount} 待改</span>
          <span class="warning">${reconcileResult.unreviewedCount} 未复核</span>
          <span class="info">${backfillQueue.length} 待补</span>
          <span class="error" style="visibility:${list.filter((issue) => issue.severity === "error").length ? "visible" : "hidden"}">${list.filter((issue) => issue.severity === "error").length} 必须修复</span>
        </div>
      </div>

      <div class="workspace">
        <aside class="outline-panel">
          <div class="panel-title"><span>章节结构</span><sl-badge>${project.blocks.length} 块</sl-badge></div>
          <div class="block-list">
            ${project.blocks.map((block, index) => {
              const blockIssues = list.filter((issue) => issue.blockId === block.id);
              const row = markOf(block);
              const dotClass = row ? `mark-${row.mark}${row.pendingBackfill ? " pending-backfill" : ""}` : "mark-unreviewed";
              const localTag = block.reviewStatus === "approved" ? "·本地已审" : block.reviewStatus === "needs-work" ? "·本地退回" : "";
              return `<button class="block-item ${block.id === active.id ? "active" : ""}" data-action="select-block" data-block-id="${block.id}" title="段落编号 ${escapeHtml(block.paraRef)}${row ? `；审校单：${MARK_LABEL[row.mark]}` : ""}${localTag ? `；${localTag}` : ""}">
                <span class="block-order">${index + 1}</span>
                <span class="block-copy"><b>${block.paraRef} · ${block.type === "heading" ? `H${block.headingLevel}` : blockRole(block)}</b><span>${escapeHtml(block.accessibleText || block.text || "（空）")}</span></span>
                <i class="${dotClass}" title="${row ? MARK_LABEL[row.mark] : "未复核"}"></i>
                ${blockIssues.length ? `<em>${blockIssues.length}</em>` : ""}
              </button>`;
            }).join("")}
          </div>
          <input id="chapter-file" type="file" accept=".txt,.md,.markdown" hidden />
          <sl-button class="import-button" variant="default" data-action="import">导入章节文本</sl-button>
          <div class="keyboard-note"><b>键盘</b><span><kbd>J</kbd><kbd>K</kbd> 跳转问题</span><span><kbd>E</kbd> 自动改写</span><span><kbd>⌘ Z</kbd> 撤销</span><span><kbd>1</kbd><kbd>2</kbd> 预览模式</span></div>
        </aside>

        <main class="editor-panel">
          <div class="editor-head">
            <div><span class="eyebrow">段落编号 ${escapeHtml(active.paraRef)} · 当前内容块</span><h1>${blockRole(active)}</h1></div>
          </div>

          <div class="reconcile-strip">
            <div class="reconcile-side">
              <span class="eyebrow">审校室结论（导出依据）</span>
              ${renderReconcileChip(markOf(active))}
            </div>
            <div class="reconcile-side local">
              <span class="eyebrow">工作台本地复核（不作导出依据）</span>
              <div class="review-actions">
                <sl-button size="small" variant="${active.reviewStatus === "approved" ? "success" : "default"}" data-action="approve">${active.reviewStatus === "approved" ? "✓ 本地已通过" : "本地通过"}</sl-button>
                <sl-button size="small" variant="${active.reviewStatus === "needs-work" ? "danger" : "default"}" data-action="needs-work">本地退回</sl-button>
              </div>
              <small>内容改动时间：${formatStamp(active.contentUpdatedAt)}${active.reviewStatus === "approved" && markOf(active)?.mark !== "reviewed" ? "；本地已通过但审校单未确认，导出仍记未复核" : ""}</small>
            </div>
          </div>

          ${activeIssues.length ? `<div class="active-issues">${activeIssues.map((issue) => `
            <div class="issue-card ${issue.severity}">
              <div><sl-badge variant="${issue.severity === "error" ? "danger" : issue.severity === "warning" ? "warning" : "primary"}">${severityLabel(issue.severity)}</sl-badge><strong>${escapeHtml(issue.title)}</strong></div>
              <p>${escapeHtml(issue.detail)}</p><small>${escapeHtml(issue.suggestion)}</small>
            </div>`).join("")}</div>` : `<div class="issue-clear">✓ 当前内容块没有新的无障碍问题</div>`}

          <section class="edit-card source-card">
            <div class="section-heading"><div><span class="eyebrow">原教材</span><h2>${active.type === "image" ? "图片信息" : active.type === "link" ? "链接信息" : "原文"}</h2></div><sl-badge variant="neutral">${active.type}</sl-badge></div>
            ${renderSourceEditor(active)}
          </section>

          <section class="edit-card rewrite-card">
            <div class="section-heading">
              <div><span class="eyebrow">Accessible rewrite</span><h2>无障碍表达</h2></div>
              <sl-button size="small" variant="primary" outline data-action="generate">生成易读版本</sl-button>
            </div>
            ${renderAccessibleEditor(active)}
            <label class="field-label" for="reason-${active.id}">改写原因（每处改写必须记录）</label>
            <sl-textarea id="reason-${active.id}" data-field="reason" rows="2" value="${escapeHtml(active.changeReason)}" placeholder="例如：拆分长句、替换专业表达、补充链接目的"></sl-textarea>
          </section>

          <section class="edit-card">
            <div class="section-heading"><div><span class="eyebrow">Review discussion</span><h2>批注与回复</h2></div><sl-badge variant="warning">${active.comments.length} 条</sl-badge></div>
            <div class="comment-compose"><sl-textarea id="new-comment" rows="2" placeholder="记录改写依据、审核意见或术语讨论…"></sl-textarea><sl-button size="small" variant="primary" data-action="add-comment">添加批注</sl-button></div>
            <div class="comment-list">
              ${active.comments.length ? active.comments.map((comment) => `
                <article class="comment ${comment.resolved ? "resolved" : ""}">
                  <header><b>${escapeHtml(comment.author)}</b><time>${new Date(comment.createdAt).toLocaleString()}</time></header>
                  <p>${escapeHtml(comment.body)}</p>
                  ${comment.replies.map((reply) => `<div class="reply"><b>${escapeHtml(reply.author)}</b><span>${escapeHtml(reply.body)}</span></div>`).join("")}
                  <div class="reply-row"><sl-input size="small" id="reply-${comment.id}" placeholder="回复…"></sl-input><sl-button size="small" data-action="reply" data-comment-id="${comment.id}">回复</sl-button><sl-button size="small" variant="text" data-action="resolve-comment" data-comment-id="${comment.id}">${comment.resolved ? "重新打开" : "解决"}</sl-button></div>
                </article>`).join("") : `<div class="empty-note">当前内容块还没有批注。</div>`}
            </div>
          </section>
        </main>

        <aside class="review-panel">
          <section class="reconcile-card">
            <div class="section-heading"><div><span class="eyebrow">Review room reconciliation</span><h2>审校对账</h2></div>
              <span class="room-pill ${reconcileError ? "off" : "on"}">${reconcileBusy ? "对账中" : reconcileError ? "取不到" : "已取单"}</span>
            </div>
            <dl class="reconcile-meta">
              <div><dt>审校单</dt><dd>${escapeHtml(reconcileResult.sheet?.sheetNo ?? "—")}</dd></div>
              <div><dt>出具时间</dt><dd>${formatStamp(reconcileResult.sheet?.issuedAt ?? null)}</dd></div>
              <div><dt>取单方式</dt><dd>${reconcileResult.source === "live" ? "实时" : reconcileResult.sheet ? "缓存兜底" : "无缓存"}</dd></div>
            </dl>
            <div class="reconcile-counts">
              <span class="mark-reviewed">${reconcileResult.reviewedCount} 已复核</span>
              <span class="mark-pending-revision">${reconcileResult.returnedCount} 待改</span>
              <span class="mark-unreviewed">${reconcileResult.unreviewedCount} 未复核</span>
            </div>
            <div class="reconcile-buttons">
              <sl-button size="small" variant="primary" outline data-action="sync-room" ${reconcileBusy ? "loading" : ""}>拉取审校单</sl-button>
              <sl-button size="small" variant="default" data-action="review-room">打开审校室</sl-button>
            </div>
            ${backfillQueue.length ? `<div class="backfill-box"><b>待补清单（${backfillQueue.length} 段）</b>${backfillQueue.slice(0, 5).map((entry) => `<span title="${escapeHtml(entry.reason)}">${escapeHtml(entry.paraRef)}</span>`).join("")}${backfillQueue.length > 5 ? `<small>等共 ${backfillQueue.length} 段，恢复后按编号补回</small>` : ""}</div>` : `<div class="backfill-box clear">待补清单为空</div>`}
            ${reconcileResult.reconfirm.length ? `<div class="reconfirm-box"><b>需重新确认（${reconcileResult.reconfirm.length} 段）</b>${reconcileResult.reconfirm.map((row) => `<span>${escapeHtml(row.paraRef)} · ${escapeHtml(row.note.slice(0, 18))}…</span>`).join("")}</div>` : ""}
            ${reconcileError ? `<p class="room-warning">审校单暂时取不到，导出照做；缺对账段落已进待补清单，改写稿与批注不受影响。</p>` : ""}
          </section>

          <section class="preview-card">
            <div class="section-heading"><div><span class="eyebrow">Reader preview</span><h2>阅读预览</h2></div><div class="mode-switch"><button class="${previewMode === "normal" ? "active" : ""}" data-action="preview-normal">普通</button><button class="${previewMode === "assisted" ? "active" : ""}" data-action="preview-assisted">辅助</button></div></div>
            <div class="reader-preview mode-${previewMode}">${renderPreview()}</div>
          </section>

          <section class="order-card">
            <div class="section-heading"><div><span class="eyebrow">Screen reader order</span><h2>读屏阅读顺序</h2></div><sl-badge>从上到下</sl-badge></div>
            <ol class="reading-order">
              ${project.blocks.map((block, index) => `<li class="${block.id === active.id ? "active" : ""}"><b>${index + 1}</b><div><strong>${blockRole(block)}</strong><span>${escapeHtml(block.accessibleText || block.text || "（无内容）")}</span></div></li>`).join("")}
            </ol>
          </section>

          <section class="issues-panel">
            <div class="section-heading"><div><span class="eyebrow">All checks</span><h2>全章问题</h2></div><sl-button size="small" variant="default" outline data-action="approve-all">本地全部通过</sl-button></div>
            <div class="issue-list">
              ${list.length ? list.map((issue) => `<button class="${issue.id === activeIssueId ? "active" : ""} ${issue.severity}" data-action="jump-issue" data-issue-id="${issue.id}" data-block-id="${issue.blockId}"><span>${severityLabel(issue.severity)}</span><b>${escapeHtml(issue.title)}</b><small>段 ${project.blocks.findIndex((block) => block.id === issue.blockId) + 1} · ${escapeHtml(issue.suggestion)}</small></button>`).join("") : `<div class="issue-clear">✓ 全章检查通过</div>`}
            </div>
          </section>

          <section class="version-card">
            <div class="section-heading"><div><span class="eyebrow">Version compare</span><h2>版本比较</h2></div><sl-badge>${project.versions.length} 版</sl-badge></div>
            ${project.versions.length ? `
              <sl-select id="version-select" size="small" value="${version?.id ?? ""}">${project.versions.map((item) => `<sl-option value="${item.id}">${escapeHtml(item.label)} · ${new Date(item.createdAt).toLocaleTimeString()}</sl-option>`).join("")}</sl-select>
              <div class="version-diff">${version ? renderVersionDiff(version, active) : ""}</div>
            ` : `<div class="empty-note">保存版本后，可比较改写前后的无障碍文本。</div>`}
          </section>
        </aside>
      </div>

      <footer class="statusbar"><span>最近操作：${escapeHtml(document.documentElement.dataset.lastAction || "示例章节已载入")}</span><span>${project.blocks.length} 个内容块 · 审校单「${escapeHtml(reconcileResult.sheet?.sheetNo ?? "取不到")}」出具 ${formatStamp(reconcileResult.sheet?.issuedAt ?? null)} · 待补 ${backfillQueue.length} 段</span></footer>
    </div>

    <sl-dialog label="全书术语表" ${showGlossary ? "open" : ""} data-dialog="glossary">
      <div class="glossary-editor">
        ${project.glossary.map((term) => `<div class="term-row"><div><b>${escapeHtml(term.source)}</b><sl-input size="small" value="${escapeHtml(term.preferred)}" data-term-id="${term.id}"></sl-input><small>${escapeHtml(term.note)}</small></div><sl-button size="small" variant="danger" outline data-action="remove-term" data-term-id="${term.id}">删除</sl-button></div>`).join("")}
      </div>
      <div class="term-add"><sl-input id="new-term-source" placeholder="原文术语"></sl-input><sl-input id="new-term-preferred" placeholder="统一表达"></sl-input><sl-button variant="primary" data-action="add-term">添加术语</sl-button></div>
      <sl-button slot="footer" variant="primary" data-action="close-glossary">完成</sl-button>
    </sl-dialog>

    ${renderReviewRoomDialog()}`;

  wireLiveFields();
}

function renderSourceEditor(block: ContentBlock) {
  if (block.type === "image") {
    return `<div class="image-source"><img src="${escapeHtml(block.imageSrc ?? "")}" alt="" /><div><b>图注</b><p>${escapeHtml(block.text)}</p><b>现有替代文本</b><p>${escapeHtml(block.imageAlt || "（空）")}</p></div></div>
      <sl-input id="source-${block.id}" data-field="source" label="图注" value="${escapeHtml(block.text)}"></sl-input>
      <sl-input id="image-alt-${block.id}" data-field="image-alt" label="替代文本" value="${escapeHtml(block.imageAlt ?? "")}" help-text="描述图片传达的信息，不写“图片”二字。"></sl-input>`;
  }
  if (block.type === "link") {
    return `<sl-input id="source-${block.id}" data-field="source" label="原链接文案" value="${escapeHtml(block.text)}"></sl-input><sl-input id="link-href-${block.id}" data-field="link-href" label="链接地址" value="${escapeHtml(block.linkHref ?? "")}"></sl-input>`;
  }
  if (block.type === "heading") {
    return `<div class="heading-edit"><sl-select id="heading-level-${block.id}" data-field="heading-level" label="标题层级" value="${String(block.headingLevel ?? 2)}"><sl-option value="1">H1</sl-option><sl-option value="2">H2</sl-option><sl-option value="3">H3</sl-option><sl-option value="4">H4</sl-option></sl-select><sl-input id="source-${block.id}" data-field="source" label="标题文本" value="${escapeHtml(block.text)}"></sl-input></div>`;
  }
  return `<sl-textarea id="source-${block.id}" data-field="source" rows="4" value="${escapeHtml(block.text)}"></sl-textarea>`;
}

function renderAccessibleEditor(block: ContentBlock) {
  if (block.type === "image") {
    return `<sl-textarea id="accessible-${block.id}" data-field="accessible" rows="3" label="图片替代文本" value="${escapeHtml(block.imageAlt || block.accessibleText)}" help-text="读屏软件会朗读这里的内容。"></sl-textarea>`;
  }
  return `<sl-textarea id="accessible-${block.id}" data-field="accessible" rows="6" value="${escapeHtml(block.accessibleText)}"></sl-textarea>`;
}

function renderPreview() {
  return project.blocks.map((block, index) => {
    const content = escapeHtml(block.accessibleText || block.text);
    if (block.type === "heading") {
      const tag = `h${Math.min(6, Math.max(1, block.headingLevel ?? 2))}`;
      return `<${tag} class="${block.id === activeBlockId ? "active-block" : ""}"><span class="order-marker">${index + 1}</span>${content}</${tag}>`;
    }
    if (block.type === "image") {
      return `<figure class="${block.id === activeBlockId ? "active-block" : ""}"><img src="${escapeHtml(block.imageSrc ?? "")}" alt="${escapeHtml(block.imageAlt || block.accessibleText)}"><figcaption><span class="order-marker">${index + 1}</span>${escapeHtml(block.text)}</figcaption></figure>`;
    }
    if (block.type === "link") {
      return `<p class="${block.id === activeBlockId ? "active-block" : ""}"><span class="order-marker">${index + 1}</span><a href="${escapeHtml(block.linkHref ?? "#")}" onclick="return false">${content}</a><span class="link-role">链接</span></p>`;
    }
    return `<p class="${block.id === activeBlockId ? "active-block" : ""}"><span class="order-marker">${index + 1}</span>${content}</p>`;
  }).join("");
}

function renderVersionDiff(version: VersionSnapshot, current: ContentBlock) {
  const oldBlock = version.blocks.find((block) => block.id === current.id);
  if (!oldBlock) return `<div class="empty-note">当前内容块不在该版本中。</div>`;
  return `<div class="diff-column"><span>旧版</span><p>${escapeHtml(oldBlock.accessibleText || oldBlock.text)}</p></div><div class="diff-column current"><span>当前</span><p>${escapeHtml(current.accessibleText || current.text)}</p></div>`;
}

function toDatetimeLocalValue(ms: number) {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderReviewRoomDialog() {
  const room = getReviewRoomState();
  const itemsByPara = new Map(room.sheet.items.map((item) => [item.paraRef, item]));
  return `<sl-dialog label="审校室 · 审校单（模拟）" class="review-room-dialog" ${showReviewRoom ? "open" : ""} data-dialog="review-room">
    <p class="room-dialog-intro">审校单由审校室独立维护，工作台只读取。两边按段落编号与出具时间对账；结论出具时间早于段落改动时间的「通过」不再算通过。</p>
    <div class="room-controls">
      <label class="room-field"><span>审校单编号</span><input type="text" id="room-sheet-no" value="${escapeHtml(room.sheet.sheetNo)}"></label>
      <label class="room-field"><span>整单出具时间</span><input type="text" readonly value="${formatStamp(room.sheet.issuedAt)}"></label>
      <label class="room-switch"><input type="checkbox" id="room-offline" ${room.offline ? "checked" : ""}> 断开与审校室的连接（模拟取单失败）</label>
    </div>
    <table class="room-table">
      <thead><tr><th>段落编号</th><th>审校结论</th><th>结论出具时间</th></tr></thead>
      <tbody>
        ${project.blocks.map((block) => {
          const item = itemsByPara.get(block.paraRef);
          const decision = item?.decision ?? "none";
          const issuedAt = item?.issuedAt ?? room.sheet.issuedAt;
          const stale = item ? item.issuedAt < block.contentUpdatedAt : false;
          return `<tr>
            <td><b>${escapeHtml(block.paraRef)}</b><small>改动于 ${formatStamp(block.contentUpdatedAt)}</small></td>
            <td>
              <select id="room-decision-${block.paraRef}" data-para-ref="${escapeHtml(block.paraRef)}">
                <option value="pass" ${decision === "pass" ? "selected" : ""}>通过</option>
                <option value="return" ${decision === "return" ? "selected" : ""}>退回</option>
                <option value="none" ${decision === "none" ? "selected" : ""}>未给结论</option>
              </select>
            </td>
            <td><input type="datetime-local" id="room-issued-${block.paraRef}" data-para-ref="${escapeHtml(block.paraRef)}" value="${toDatetimeLocalValue(issuedAt)}" step="60">${stale ? `<small class="stale-warn">早于段落改动</small>` : ""}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
    <p class="room-dialog-actions">
      <sl-button size="small" variant="warning" outline data-action="reissue-sheet">审校室重新出具审校单（时间改为现在）</sl-button>
      <sl-button size="small" variant="primary" data-action="sync-after-room">保存并拉取对账</sl-button>
    </p>
    <sl-button slot="footer" variant="default" data-action="close-review-room">关闭</sl-button>
  </sl-dialog>`;
}

function wireLiveFields() {
  app.querySelectorAll<HTMLElement>("sl-input[data-field], sl-textarea[data-field], sl-select[data-field]").forEach((element) => {
    element.addEventListener("sl-input", () => {
      const value = (element as HTMLElement & { value: string }).value;
      updateActiveBlock((block) => {
        const field = element.dataset.field;
        if (field === "source") { block.text = value; block.contentUpdatedAt = Date.now(); }
        if (field === "accessible") {
          block.accessibleText = value;
          if (block.type === "image") block.imageAlt = value;
          block.contentUpdatedAt = Date.now();
        }
        if (field === "image-alt") {
          block.imageAlt = value;
          block.accessibleText = value;
          block.contentUpdatedAt = Date.now();
        }
        if (field === "link-href") { block.linkHref = value; block.contentUpdatedAt = Date.now(); }
        // 改写原因不属于段落内容，不刷新 contentUpdatedAt，也不必请审校室重新确认。
        if (field === "reason") block.changeReason = value;
        if (field !== "reason") block.reviewStatus = "pending";
      }, "编辑无障碍文本", false);
    });
    element.addEventListener("sl-change", () => render());
  });
}

app.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "undo") undo();
  if (action === "redo") redo();
  if (action === "select-block") {
    activeBlockId = target.dataset.blockId ?? activeBlockId;
    activeIssueId = "";
    render();
  }
  if (action === "jump-issue") {
    activeIssueId = target.dataset.issueId ?? "";
    activeBlockId = target.dataset.blockId ?? activeBlockId;
    render();
    requestAnimationFrame(() => app.querySelector<HTMLElement>(".editor-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  if (action === "generate") {
    const block = activeBlock();
    const suggestion = block.type === "link"
      ? "打开水循环互动实验"
      : simplifyText(block.type === "image" ? block.imageAlt || block.text : block.text, project.glossary);
    updateActiveBlock((current) => {
      if (current.type === "image") current.imageAlt = suggestion;
      current.accessibleText = suggestion;
      current.changeReason ||= "拆分长句并替换复杂表达，保留原有知识信息。";
      current.reviewStatus = "pending";
      current.contentUpdatedAt = Date.now();
    }, "生成易读版本");
  }
  if (action === "approve") updateActiveBlock((block) => { block.reviewStatus = "approved"; }, "本地复核通过");
  if (action === "needs-work") updateActiveBlock((block) => { block.reviewStatus = "needs-work"; }, "本地标记退回");
  if (action === "add-comment") {
    const input = app.querySelector<HTMLElement & { value: string }>("#new-comment");
    const body = input?.value.trim();
    if (body) updateActiveBlock((block) => {
      block.comments.unshift({ id: uid("comment"), author: "当前编辑", body, createdAt: new Date().toISOString(), resolved: false, replies: [] });
    }, "添加批注");
  }
  if (action === "reply") {
    const commentId = target.dataset.commentId ?? "";
    const input = app.querySelector<HTMLElement & { value: string }>(`#reply-${CSS.escape(commentId)}`);
    const body = input?.value.trim();
    if (body) updateActiveBlock((block) => {
      block.comments.find((comment) => comment.id === commentId)?.replies.push({ id: uid("reply"), author: "当前编辑", body, createdAt: new Date().toISOString() });
    }, "回复批注");
  }
  if (action === "resolve-comment") {
    const commentId = target.dataset.commentId ?? "";
    updateActiveBlock((block) => {
      const comment = block.comments.find((item) => item.id === commentId);
      if (comment) comment.resolved = !comment.resolved;
    }, "更新批注状态");
  }
  if (action === "preview-normal") { previewMode = "normal"; render(); }
  if (action === "preview-assisted") { previewMode = "assisted"; render(); }
  if (action === "glossary") { showGlossary = true; render(); }
  if (action === "close-glossary") { showGlossary = false; render(); }
  if (action === "add-term") {
    const source = app.querySelector<HTMLElement & { value: string }>("#new-term-source");
    const preferred = app.querySelector<HTMLElement & { value: string }>("#new-term-preferred");
    if (source?.value.trim() && preferred?.value.trim()) {
      commit("添加术语", (draft) => { draft.glossary.push({ id: uid("term"), source: source.value.trim(), preferred: preferred.value.trim(), note: "编辑新增术语" }); });
    }
  }
  if (action === "remove-term") {
    const termId = target.dataset.termId;
    commit("删除术语", (draft) => { draft.glossary = draft.glossary.filter((term) => term.id !== termId); });
  }
  if (action === "save-version") {
    const versionId = uid("version");
    commit("保存版本快照", (draft) => {
      draft.versions.unshift({ id: versionId, label: `版本 ${draft.versions.length + 1}`, createdAt: new Date().toISOString(), blocks: structuredClone(draft.blocks), glossary: structuredClone(draft.glossary) });
      draft.versions = draft.versions.slice(0, 10);
    });
    selectedVersionId = versionId;
    render();
  }
  if (action === "approve-all") {
    commit("本地全部通过", (draft) => { draft.blocks.forEach((block) => { block.reviewStatus = "approved"; }); });
  }
  if (action === "export") {
    void (async () => {
      await syncWithReviewRoom();
      // 以刚刚完成的对账结果导出；取不到单时导出照做，缺对账段落进待补清单。
      download(`${project.title.replace(/[\\/:*?"<>|]/g, "_")}-无障碍版.html`, exportHtml(project, reconcileResult));
      document.documentElement.dataset.lastAction = reconcileError
        ? "审校单取不到，已按缓存导出并登记待补清单"
        : "已按审校单结论导出无障碍 HTML";
      render();
    })();
  }
  if (action === "sync-room") void syncWithReviewRoom();
  if (action === "review-room") { showReviewRoom = true; render(); }
  if (action === "close-review-room") { showReviewRoom = false; render(); }
  if (action === "reissue-sheet") {
    reissueSheet();
    void syncWithReviewRoom();
    showReviewRoom = false;
  }
  if (action === "sync-after-room") {
    showReviewRoom = false;
    void syncWithReviewRoom();
  }
  if (action === "import") app.querySelector<HTMLInputElement>("#chapter-file")?.click();
});

app.addEventListener("sl-after-hide", (event) => {
  const dialog = event.target as HTMLElement;
  if (dialog.matches('[data-dialog="review-room"]') && showReviewRoom) {
    showReviewRoom = false;
    render();
  }
  if (dialog.matches('[data-dialog="glossary"]') && showGlossary) {
    showGlossary = false;
  }
});

app.addEventListener("sl-change", (event) => {
  const element = event.target as HTMLElement;
  if (element.id === "chapter-file") return;
  if (element.id.startsWith("heading-level-")) {
    const level = Number((element as HTMLElement & { value: string }).value);
    updateActiveBlock((block) => { block.headingLevel = level; block.reviewStatus = "pending"; block.contentUpdatedAt = Date.now(); }, "修改标题层级");
  }
  if (element.id === "version-select") {
    selectedVersionId = (element as HTMLElement & { value: string }).value;
    render();
  }
  if (element.matches("[data-term-id]")) {
    const termId = element.dataset.termId;
    const value = (element as HTMLElement & { value: string }).value;
    commit("修改术语表", (draft) => { const term = draft.glossary.find((item) => item.id === termId); if (term) term.preferred = value; });
  }
});

app.addEventListener("change", (event) => {
  const input = event.target as HTMLElement;

  // 审校室弹窗（原生控件）
  if (input.id === "room-offline") {
    setReviewRoomOffline((input as HTMLInputElement).checked);
    void syncWithReviewRoom();
    return;
  }
  if (input.id === "room-sheet-no") {
    setSheetMeta((input as HTMLInputElement).value);
    return;
  }
  if (input.matches("select[data-para-ref]") || input.matches("input[type='datetime-local'][data-para-ref]") || input.id.startsWith("room-decision-") || input.id.startsWith("room-issued-")) {
    const paraRef = (input as HTMLElement).dataset.paraRef ?? "";
    if (!paraRef) return;
    const decisionEl = app.querySelector<HTMLSelectElement>(`#room-decision-${CSS.escape(paraRef)}`);
    const issuedEl = app.querySelector<HTMLInputElement>(`#room-issued-${CSS.escape(paraRef)}`);
    const decision = decisionEl?.value as ReviewDecision | "none" | undefined;
    const issuedAt = issuedEl?.value ? new Date(issuedEl.value).getTime() : NaN;
    if (decision === "none") {
      // 未给结论：从审校单移除该段。
      removeReviewItem(paraRef);
    } else if (decision && Number.isFinite(issuedAt)) {
      updateReviewItem(paraRef, decision, issuedAt);
    }
    // 重新向审校室取单对账（弹窗保持打开）；当前断开则退回缓存/待补分支。
    void syncWithReviewRoom();
    return;
  }

  if (!(input instanceof HTMLInputElement)) return;
  if (input.id !== "chapter-file" || !input.files?.[0]) return;
  void input.files[0].text().then((text) => {
    commit("导入章节文本", (draft) => {
      draft.blocks = parseImportedChapter(text);
      activeBlockId = draft.blocks[0]?.id ?? "";
      activeIssueId = "";
    });
  });
});

app.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === "project-title") {
    project.title = input.value;
    saveSoon();
  }
});

window.addEventListener("online", () => { void syncWithReviewRoom(); });
window.addEventListener("offline", render);
window.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if (target.matches("input, textarea, sl-input, sl-textarea, [contenteditable='true']")) return;
  const command = event.metaKey || event.ctrlKey;
  if (command && event.key.toLowerCase() === "z") {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
    return;
  }
  if (command && event.key.toLowerCase() === "s") {
    event.preventDefault();
    const versionId = uid("version");
    commit("键盘保存版本", (draft) => { draft.versions.unshift({ id: versionId, label: `版本 ${draft.versions.length + 1}`, createdAt: new Date().toISOString(), blocks: structuredClone(draft.blocks), glossary: structuredClone(draft.glossary) }); });
    selectedVersionId = versionId;
    return;
  }
  if (event.key.toLowerCase() === "j" || event.key.toLowerCase() === "k") {
    const list = issues();
    if (!list.length) return;
    const current = Math.max(0, list.findIndex((issue) => issue.id === activeIssueId));
    const next = (current + (event.key.toLowerCase() === "j" ? 1 : -1) + list.length) % list.length;
    activeIssueId = list[next].id;
    activeBlockId = list[next].blockId;
    render();
  }
  if (event.key.toLowerCase() === "e") {
    const button = app.querySelector<HTMLElement>('[data-action="generate"]');
    button?.click();
  }
  if (event.key === "1") { previewMode = "normal"; render(); }
  if (event.key === "2") { previewMode = "assisted"; render(); }
});

render();
// 启动即向审校室取单对账；取不到时靠缓存/待补清单兜底，不阻塞工作台。
void syncWithReviewRoom({ renderWhenDone: true });
