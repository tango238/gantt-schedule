import {
  findViolations,
  formatDuration,
  getDerived,
  isWorkingDay,
  visibleRows,
  buildTreeIndex,
  allLeavesDone,
  overdueReasons,
  statusOf,
  type OverdueReason,
  type DerivedIndex,
  type TreeIndex,
  type Violation,
  type WorkCalendar,
} from "../../../shared/engine";
import { t } from "../../i18n";
import { addDays, dayOfWeek, diffDays } from "../../../shared/model/date";
import { idKey } from "../../../shared/model/id";
import type { GanttDocument, IsoDate, TaskStatus, Zoom } from "../../../shared/model/types";
import {
  ARROW_GAP,
  BAR_OFFSET_Y,
  COL_ASSIGNEE,
  COLORS,
  MILESTONE_HALF,
  DAY_WIDTH,
  ROW_HEIGHT,
  SUMMARY_OFFSET_Y,
} from "./constants";

export interface LayoutInput {
  doc: GanttDocument;
  derived: DerivedIndex;
  wc: WorkCalendar;
  zoom: Zoom;
  /** Collapsed task ids (any case). */
  collapsed: ReadonlySet<string>;
  valueColumn: "duration" | "hours";
  /** Fixed range (e.g. during a drag); computed from the tasks when omitted. */
  range?: { start: IsoDate; end: IsoDate };
  /** Optional precomputed values (avoid recomputation). */
  ix?: TreeIndex;
  violations?: readonly Violation[];
  /** Optional precomputed visible row ids (must match `collapsed`). */
  rowIds?: readonly string[];
  /** ユーザー ID -> 名前 (大文字小文字を区別する)。null = まだ読み込めていない (担当は表示しない)。 */
  users?: ReadonlyMap<string, string> | null;
  /** タスク ID (小文字) -> コメント件数。 */
  commentCounts?: Readonly<Record<string, number>>;
}

/** 期限超過の理由の配列は参照を共有する (行の同一性判定 = shallowEqual のため)。 */
const NO_REASONS: OverdueReason[] = [];
const REASON_SETS = new Map<string, OverdueReason[]>();
function canonReasons(r: OverdueReason[]): OverdueReason[] {
  if (r.length === 0) return NO_REASONS;
  const k = r.join(",");
  let c = REASON_SETS.get(k);
  if (!c) REASON_SETS.set(k, (c = r));
  return c;
}

/** 「カテゴリなし」の仮想の見出し行の taskId (doc には存在しない)。 */
export const UNCATEGORIZED_ROW_ID = "__uncategorized__";

/** 文字幅の概算 (全角 = fontSize、半角 = 約 0.58 fontSize)。SVG の text には省略記号が無いので自前で切る。 */
export function fitText(text: string, maxPx: number, fontSize: number): string {
  const widthOf = (ch: string) => (/[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? fontSize : fontSize * 0.58);
  const chars = Array.from(text);
  let w = 0;
  for (const c of chars) w += widthOf(c);
  if (w <= maxPx) return text;
  const ell = fontSize * 0.9;
  let out = "";
  w = ell;
  for (const c of chars) {
    w += widthOf(c);
    if (w > maxPx) break;
    out += c;
  }
  return out + "…";
}

export interface RowLayout {
  taskId: string;
  index: number;
  rowNo: number;
  y: number;
  depth: number;
  isParent: boolean;
  /** カテゴリ (日付を持たない見出し行)。バーは無い。 */
  isCategory: boolean;
  /** マイルストーン (日付 1 つ。グリッドの名前の前にひし形を出す)。 */
  isMilestone?: boolean;
  /** 状態 (葉タスクのみ。それ以外は null)。 */
  status: TaskStatus | null;
  /** 完了の表示 (葉タスクが done、または親タスクの葉がすべて done): グレーアウト + 取消線。 */
  done: boolean;
  /** 期限超過の理由 (葉タスクのみ。空 = エラーなし)。 */
  overdue: OverdueReason[];
  /** カテゴリの色ラベルの色 (あれば)。 */
  color?: string;
  /** 全体スケジュールのプロジェクト見出し行 (スケジュール 1 つ分。doc には無い)。 */
  isProject?: boolean;
  /** プロジェクト見出し行の移動先 (/s/<id>)。 */
  href?: string;
  /** 見出し行に添える注記 (読み込み中・失敗)。 */
  note?: string;
  noteTone?: "error" | "muted";
  collapsed: boolean;
  name: string;
  valueText: string;
  /** 担当者名 (", " 区切り。未読み込み・担当なしは空)。 */
  assignees: string;
  /** グリッドの担当列に収まるよう省略記号で切ったもの。 */
  assigneeLabel: string;
  commentCount: number;
  /** 「カテゴリなし」の仮想行 (doc に無い。選択・編集不可、行番号なし)。 */
  virtual?: boolean;
}
export interface BarLayout {
  taskId: string;
  /** Visible row index. */
  rowIndex: number;
  kind: "leaf" | "summary" | "milestone";
  x: number;
  w: number;
  /** Top of the bar rectangle (row top + offset). */
  y: number;
  color: string;
  /** 完了 (グレー)。 */
  done: boolean;
  /** 期限超過 (赤枠)。 */
  overdue: boolean;
  /** 状態 (葉のバーのみ。未着手は薄く、進行中は濃く塗る)。 */
  status: TaskStatus | null;
  /** マイルストーンの名前 (ひし形の右に出す)。 */
  label: string;
  resourceText: string;
  /** 担当者名 (リーフのバーのみ。サマリーには出さない)。 */
  assigneeText: string;
  labelX: number;
}
export interface ArrowLayout {
  /** Original (unreplaced) task ids of the dependency. */
  succId: string;
  predId: string;
  /** Visible row indexes the arrow is drawn between (after collapse replacement). */
  fromIndex: number;
  toIndex: number;
  d: string;
  head: string;
  violated: boolean;
}
export interface HeaderCell {
  x: number;
  w: number;
  label: string;
  /** Draw in the dimmed colour (non-working day). */
  muted?: boolean;
}
export interface NonWorkingBand {
  x: number;
  w: number;
}
export interface Layout {
  range: { start: IsoDate; end: IsoDate };
  zoom: Zoom;
  dayWidth: number;
  timelineWidth: number;
  bodyHeight: number;
  rows: RowLayout[];
  bars: BarLayout[];
  arrows: ArrowLayout[];
  headerTop: HeaderCell[];
  headerBottom: HeaderCell[];
  nonWorking: NonWorkingBand[];
  todayX: number | null;
}

// ---------------------------------------------------------------------------
// Date helpers (string based, calendar days)
// ---------------------------------------------------------------------------

function ymd(d: IsoDate): [number, number, number] {
  const [y, m, dd] = d.split("-");
  return [Number(y), Number(m), Number(dd)];
}
function monthStart(d: IsoDate): IsoDate {
  return `${d.slice(0, 7)}-01`;
}
function monthEnd(d: IsoDate): IsoDate {
  const [y, m] = ymd(d);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return addDays(next, -1);
}
function mondayOnOrBefore(d: IsoDate): IsoDate {
  return addDays(d, -((dayOfWeek(d) + 6) % 7));
}
function sundayOnOrAfter(d: IsoDate): IsoDate {
  return addDays(d, (7 - dayOfWeek(d)) % 7);
}
function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

/** Displayed range (03 section 2.2). */
export function computeRange(
  derived: DerivedIndex,
  zoom: Zoom,
  today: IsoDate,
): { start: IsoDate; end: IsoDate } {
  const [minStart, maxEnd] = taskSpan(derived);
  return rangeAround(minStart, maxEnd, zoom, today);
}

/** 日付を持つ行 (カテゴリ以外) の最小の開始日と最大の終了日。 */
export function taskSpan(derived: DerivedIndex): [IsoDate | null, IsoDate | null] {
  let minStart: IsoDate | null = null;
  let maxEnd: IsoDate | null = null;
  for (const dt of derived.byId.values()) {
    if (dt.isCategory) continue;
    if (minStart === null || dt.start < minStart) minStart = dt.start;
    if (maxEnd === null || dt.end > maxEnd) maxEnd = dt.end;
  }
  return [minStart, maxEnd];
}

/** 表示範囲 (タスクの最小/最大の日付の前後に余白)。日付が無ければ今日。 */
export function rangeAround(
  minStart: IsoDate | null,
  maxEnd: IsoDate | null,
  zoom: Zoom,
  today: IsoDate,
): { start: IsoDate; end: IsoDate } {
  const s = minStart ?? today;
  const e = maxEnd ?? today;
  if (zoom === "month") {
    return { start: monthStart(addDays(s, -7)), end: monthEnd(addDays(e, 60)) };
  }
  return { start: mondayOnOrBefore(addDays(s, -7)), end: sundayOnOrAfter(addDays(e, 28)) };
}

/** Earliest start among all tasks (or today). Used for the initial scroll position. */
export function minTaskStart(derived: DerivedIndex, today: IsoDate): IsoDate {
  let m: IsoDate | null = null;
  for (const dt of derived.byId.values()) if (!dt.isCategory && (m === null || dt.start < m)) m = dt.start;
  return m ?? today;
}

export function xOfDate(layout: Pick<Layout, "range" | "dayWidth">, d: IsoDate): number {
  return diffDays(layout.range.start, d) * layout.dayWidth;
}
export function dateAtX(layout: Pick<Layout, "range" | "dayWidth">, x: number): IsoDate {
  return addDays(layout.range.start, Math.floor(x / layout.dayWidth));
}
export function rowY(index: number): number {
  return index * ROW_HEIGHT;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function monthDayLabel(d: IsoDate): string {
  const [, m, dd] = ymd(d);
  return t("header.monthDay", { month: m, day: dd });
}

export function buildHeader(
  range: { start: IsoDate; end: IsoDate },
  zoom: Zoom,
  dayWidth: number,
  wc: WorkCalendar,
): { top: HeaderCell[]; bottom: HeaderCell[] } {
  const top: HeaderCell[] = [];
  const bottom: HeaderCell[] = [];
  const totalDays = diffDays(range.start, range.end) + 1;
  const xOf = (d: IsoDate) => diffDays(range.start, d) * dayWidth;

  if (zoom === "day" || zoom === "week") {
    // Weeks Monday..Sunday (range is aligned to weeks).
    for (let off = 0; off < totalDays; off += 7) {
      const from = addDays(range.start, off);
      const to = addDays(from, 6);
      const x = off * dayWidth;
      const w = 7 * dayWidth;
      if (zoom === "day") {
        top.push({
          x,
          w,
          label: t("header.weekRange", { year: ymd(from)[0], from: monthDayLabel(from), to: monthDayLabel(to) }),
        });
      } else {
        const [, fm, fd] = ymd(from);
        const [, tm, td] = ymd(to);
        bottom.push({ x, w, label: t("header.weekCell", { fromMonth: fm, fromDay: fd, toMonth: tm, toDay: td }) });
      }
    }
    if (zoom === "day") {
      for (let i = 0; i < totalDays; i++) {
        const d = addDays(range.start, i);
        bottom.push({
          x: i * dayWidth,
          w: dayWidth,
          label: t("header.dayCell", { day: ymd(d)[2], weekday: t(`weekday.${dayOfWeek(d)}`) }),
          muted: wc.enabled && !isWorkingDay(d, wc),
        });
      }
    } else {
      // top: months, clipped to the range
      let cur = range.start;
      while (cur <= range.end) {
        const last = minDate(monthEnd(cur), range.end);
        const [y, m] = ymd(cur);
        top.push({ x: xOf(cur), w: (diffDays(cur, last) + 1) * dayWidth, label: t("header.month", { year: y, month: m }) });
        cur = addDays(last, 1);
      }
    }
  } else {
    let cur = range.start;
    while (cur <= range.end) {
      const lastM = minDate(monthEnd(cur), range.end);
      const [, m] = ymd(cur);
      bottom.push({ x: xOf(cur), w: (diffDays(cur, lastM) + 1) * dayWidth, label: t("header.monthShort", { month: m }) });
      cur = addDays(lastM, 1);
    }
    cur = range.start;
    while (cur <= range.end) {
      const [y] = ymd(cur);
      const lastY = minDate(`${y}-12-31`, range.end);
      top.push({ x: xOf(cur), w: (diffDays(cur, lastY) + 1) * dayWidth, label: t("header.year", { year: y }) });
      cur = addDays(lastY, 1);
    }
  }
  return { top, bottom };
}

export function buildNonWorking(
  range: { start: IsoDate; end: IsoDate },
  zoom: Zoom,
  dayWidth: number,
  wc: WorkCalendar,
): NonWorkingBand[] {
  if (!wc.enabled || zoom === "month") return [];
  const bands: NonWorkingBand[] = [];
  const total = diffDays(range.start, range.end) + 1;
  let runStart = -1;
  for (let i = 0; i <= total; i++) {
    const off = i < total && !isWorkingDay(addDays(range.start, i), wc);
    if (off && runStart < 0) runStart = i;
    if (!off && runStart >= 0) {
      bands.push({ x: runStart * dayWidth, w: (i - runStart) * dayWidth });
      runStart = -1;
    }
  }
  return bands;
}

// ---------------------------------------------------------------------------
// Arrows
// ---------------------------------------------------------------------------

export function arrowGeometry(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  succRowTop: number,
): { d: string; head: string } {
  const G = ARROW_GAP;
  let d: string;
  if (x2 - x1 >= 2 * G) {
    d = `M ${x1} ${y1} H ${x1 + G} V ${y2} H ${x2}`;
  } else {
    const yMid = y2 > y1 ? succRowTop : succRowTop + ROW_HEIGHT;
    d = `M ${x1} ${y1} H ${x1 + G} V ${yMid} H ${x2 - G} V ${y2} H ${x2}`;
  }
  const head = `${x2},${y2} ${x2 - 6},${y2 - 3.5} ${x2 - 6},${y2 + 3.5}`;
  return { d, head };
}

// ---------------------------------------------------------------------------
// computeLayout
// ---------------------------------------------------------------------------

function formatHours(h: number): string {
  return t("grid.hoursValue", { value: Number(h.toFixed(1)) });
}

function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a) as Array<keyof typeof a>;
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/**
 * Replaces entries of `next` by the identical-looking entries of `prev` (same key, shallow equal),
 * and returns `prev` itself when nothing changed, so React.memo children can skip rendering.
 */
function reuse<T extends object>(next: T[], prev: readonly T[] | undefined, key: (x: T) => string): T[] {
  if (!prev) return next;
  const old = new Map<string, T>();
  for (const x of prev) old.set(key(x), x);
  const out = next.map((x) => {
    const o = old.get(key(x));
    return o !== undefined && shallowEqual(o, x) ? o : x;
  });
  const same = out.length === prev.length && out.every((x, i) => x === prev[i]);
  return same ? (prev as T[]) : out;
}

/**
 * Computes the whole chart geometry. When `prev` is given, unchanged rows / bars / arrows / header
 * cells keep their previous object identity (and the previous Layout is returned when nothing
 * changed), which keeps memoised SVG children from re-rendering while dragging.
 */
export function computeLayout(input: LayoutInput, today: IsoDate, prev?: Layout | null): Layout {
  const next = buildLayout(input, today);
  if (!prev) return next;
  const stable: Layout = {
    ...next,
    rows: reuse(next.rows, prev.rows, (r) => r.taskId),
    bars: reuse(next.bars, prev.bars, (b) => b.taskId),
    arrows: reuse(next.arrows, prev.arrows, (a) => `${a.succId}|${a.predId}`),
    headerTop: reuse(next.headerTop, prev.headerTop, (c) => String(c.x)),
    headerBottom: reuse(next.headerBottom, prev.headerBottom, (c) => String(c.x)),
    nonWorking: reuse(next.nonWorking, prev.nonWorking, (b) => String(b.x)),
  };
  const { range: r1, ...rest1 } = stable;
  const { range: r0, ...rest0 } = prev;
  return shallowEqual(r1, r0) && shallowEqual(rest1, rest0) ? prev : stable;
}

function buildLayout(input: LayoutInput, today: IsoDate): Layout {
  const { doc, derived, wc, zoom, valueColumn } = input;
  const ix = input.ix ?? buildTreeIndex(doc);
  const dayWidth = DAY_WIDTH[zoom];
  const range = input.range ?? computeRange(derived, zoom, today);
  const base = { range, dayWidth };

  const collapsedKeys = new Set<string>();
  for (const c of input.collapsed) collapsedKeys.add(idKey(c));

  const colorOf = new Map<string, string>();
  for (const c of doc.colorLabels ?? []) colorOf.set(idKey(c.id), c.color);
  const resName = new Map<string, string>();
  for (const r of doc.resources ?? []) resName.set(idKey(r.id), r.name);

  const userNames = input.users ?? null;
  const counts = input.commentCounts ?? {};
  const assigneeNames = (task: { assigneeIds?: string[] }): string =>
    userNames === null
      ? ""
      : (task.assigneeIds ?? []).map((u) => userNames.get(u) ?? t("assignee.unknown")).join(", ");

  const visible = input.rowIds ?? visibleRows(ix, collapsedKeys);
  // カテゴリが 1 つ以上あり、カテゴリなしのトップレベルタスクもあるとき、その先頭に仮想の見出し行を入れる。
  const ids: Array<string | null> = [...visible];
  if (doc.tasks.some((x) => x.kind === "category")) {
    const first = ids.findIndex((id) => id !== null && (ix.parentOf.get(idKey(id)) ?? null) === null && ix.byId.get(idKey(id))!.kind !== "category");
    if (first >= 0) ids.splice(first, 0, null);
  }
  // `#` is the stable serial number among all tasks (doc order), independent of collapsing.
  const serialOf = new Map<string, number>();
  derived.order.forEach((id, i) => serialOf.set(idKey(id), i + 1));
  const rowIndexOf = new Map<string, number>();
  const rows: RowLayout[] = [];
  const bars: BarLayout[] = [];

  ids.forEach((id, index) => {
    if (id === null) {
      rows.push({
        taskId: UNCATEGORIZED_ROW_ID,
        index,
        rowNo: 0,
        y: rowY(index),
        depth: 0,
        isParent: false,
        isCategory: false,
        collapsed: false,
        name: t("category.none"),
        valueText: "",
        status: null,
        done: false,
        overdue: NO_REASONS,
        assignees: "",
        assigneeLabel: "",
        commentCount: 0,
        virtual: true,
      });
      return;
    }
    const dt = getDerived(derived, id)!;
    const task = ix.byId.get(idKey(id))!;
    rowIndexOf.set(idKey(id), index);
    const y = rowY(index);
    let valueText: string;
    if (dt.isCategory) valueText = "";
    else if (dt.isMilestone) valueText = `${Number(dt.start.slice(5, 7))}/${Number(dt.start.slice(8, 10))}`;
    else if (valueColumn === "duration") valueText = formatDuration(dt.durationDays, wc);
    else valueText = dt.hours !== undefined ? formatHours(dt.hours) : "";
    const isLeafTask = !dt.isCategory && !dt.isMilestone && !dt.isParent;
    const overdue = isLeafTask ? canonReasons(overdueReasons(task.status, task.start!, task.end!, today)) : NO_REASONS;
    const done = isLeafTask ? statusOf(task) === "done" : dt.isParent && !dt.isCategory ? allLeavesDone(ix, id) : false;
    rows.push({
      taskId: id,
      index,
      rowNo: serialOf.get(idKey(id)) ?? index + 1,
      y,
      depth: dt.depth,
      isParent: dt.isParent,
      isCategory: dt.isCategory,
      ...(dt.isMilestone ? { isMilestone: true } : {}),
      status: isLeafTask ? statusOf(task) : null,
      done,
      overdue,
      ...(dt.isCategory && task.colorLabelId && colorOf.get(idKey(task.colorLabelId)) ? { color: colorOf.get(idKey(task.colorLabelId))! } : {}),
      collapsed: collapsedKeys.has(idKey(id)),
      name: task.name,
      valueText,
      assignees: dt.isCategory || dt.isMilestone ? "" : assigneeNames(task),
      assigneeLabel: dt.isCategory || dt.isMilestone ? "" : fitText(assigneeNames(task), COL_ASSIGNEE - 12, 12),
      commentCount: counts[idKey(id)] ?? 0,
    });
    if (dt.isCategory) return; // カテゴリは行全体の帯だけでバーを描かない

    const x = xOfDate(base, dt.start);
    if (dt.isMilestone) {
      // ひし形は日付のマスの中央。バーの幅は 1 日分 (ドラッグの基準)。サマリー・集計・矢印の対象外。
      const mc = (task.colorLabelId ? colorOf.get(idKey(task.colorLabelId)) : undefined) ?? COLORS.milestone;
      bars.push({
        taskId: id,
        rowIndex: index,
        kind: "milestone",
        x,
        w: dayWidth,
        y: y + BAR_OFFSET_Y,
        color: mc,
        done: false,
        overdue: false,
        status: null,
        label: task.name,
        resourceText: "",
        assigneeText: "",
        labelX: x + dayWidth / 2 + MILESTONE_HALF + 6,
      });
      return;
    }
    const rawW = xOfDate(base, dt.end) + dayWidth - x;
    const color = (task.colorLabelId ? colorOf.get(idKey(task.colorLabelId)) : undefined) ?? undefined;
    const resourceText = (task.resourceIds ?? [])
      .map((rid) => resName.get(idKey(rid)))
      .filter((n): n is string => n !== undefined)
      .join(", ");
    const kind = dt.isParent ? "summary" : "leaf";
    const w = kind === "leaf" ? Math.max(2, rawW) : rawW;
    bars.push({
      taskId: id,
      rowIndex: index,
      kind,
      x,
      w,
      y: y + (kind === "leaf" ? BAR_OFFSET_Y : SUMMARY_OFFSET_Y),
      color: color ?? (kind === "leaf" ? COLORS.barDefault : COLORS.summaryDefault),
      done,
      overdue: overdue.length > 0,
      status: kind === "leaf" ? statusOf(task) : null,
      label: "",
      resourceText,
      assigneeText: kind === "leaf" ? assigneeNames(task) : "",
      labelX: x + w + 6,
    });
  });

  // Arrows
  const violated = new Set<string>();
  for (const v of input.violations ?? findViolations(doc, wc)) violated.add(`${idKey(v.succId)}|${idKey(v.predId)}`);
  const visibleRowOf = (id: string): number | undefined => {
    let cur: string | null = id;
    const seen = new Set<string>();
    while (cur !== null && !seen.has(idKey(cur))) {
      seen.add(idKey(cur));
      const r = rowIndexOf.get(idKey(cur));
      if (r !== undefined) return r;
      cur = ix.parentOf.get(idKey(cur)) ?? null;
    }
    return undefined;
  };
  const barOfRow = new Map<number, BarLayout>();
  for (const b of bars) barOfRow.set(b.rowIndex, b);
  const arrows: ArrowLayout[] = [];
  for (const task of doc.tasks) {
    for (const dep of task.dependencies ?? []) {
      const si = visibleRowOf(task.id);
      const pi = visibleRowOf(dep.predecessorId);
      if (si === undefined || pi === undefined || si === pi) continue;
      const pb = barOfRow.get(pi);
      const sb = barOfRow.get(si);
      if (!pb || !sb) continue; // 折りたたまれたカテゴリの行にはバーが無い
      const x1 = pb.x + pb.w;
      const x2 = sb.x;
      const y1 = rowY(pi) + ROW_HEIGHT / 2;
      const y2 = rowY(si) + ROW_HEIGHT / 2;
      const { d, head } = arrowGeometry(x1, y1, x2, y2, rowY(si));
      arrows.push({
        succId: task.id,
        predId: dep.predecessorId,
        fromIndex: pi,
        toIndex: si,
        d,
        head,
        violated: violated.has(`${idKey(task.id)}|${idKey(dep.predecessorId)}`),
      });
    }
  }

  const { top, bottom } = buildHeader(range, zoom, dayWidth, wc);
  const inRange = today >= range.start && today <= range.end;

  return {
    range,
    zoom,
    dayWidth,
    timelineWidth: (diffDays(range.start, range.end) + 1) * dayWidth,
    bodyHeight: rows.length * ROW_HEIGHT,
    rows,
    bars,
    arrows,
    headerTop: top,
    headerBottom: bottom,
    nonWorking: buildNonWorking(range, zoom, dayWidth, wc),
    todayX: inRange ? xOfDate(base, today) : null,
  };
}
