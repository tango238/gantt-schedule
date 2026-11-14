import {
  buildTreeIndex,
  compileCalendar,
  deriveAll,
  getChildren,
  isCategoryTask,
  isMilestoneTask,
  statusOf,
  type TreeIndex,
} from "../../shared/engine";
import { idKey } from "../../shared/model/id";
import type { GanttDocument, IsoDate, TaskStatus, Zoom } from "../../shared/model/types";
import { t } from "../i18n";
import { DAY_WIDTH, ROW_HEIGHT } from "../components/chart/constants";
import {
  arrowGeometry,
  buildHeader,
  buildNonWorking,
  computeLayout,
  rangeAround,
  taskSpan,
  xOfDate,
  type ArrowLayout,
  type BarLayout,
  type Layout,
  type RowLayout,
} from "../components/chart/layout";
import { diffDays } from "../../shared/model/date";

/** 稼働日カレンダーを持たない背景の網掛けは、スケジュールによらず土日のみ。 */
const WEEKENDS = compileCalendar({ weekends: [0, 6], holidays: [] });

export type ProjectState =
  | { status: "loading" }
  | { status: "error"; reason: "notfound" | "failed" | "invalid" }
  | { status: "ok"; doc: GanttDocument };

export interface OverviewProject {
  id: string;
  name: string;
  state: ProjectState;
}

export interface OverviewInput {
  projects: readonly OverviewProject[];
  zoom: Zoom;
  valueColumn: "duration" | "hours";
  /** 折りたたんだ行のキー。`rowKey` / `collapseKey` で作ったもの。 */
  collapsed: ReadonlySet<string>;
  /** ユーザー ID -> 名前 (null = 未取得で担当は出さない)。 */
  users: ReadonlyMap<string, string> | null;
  /** タスクの絞り込み (省略 = 絞り込まない)。 */
  filter?: TaskFilter;
}

/** タスクの絞り込み。どちらも空なら絞り込まない。 */
export interface TaskFilter {
  /** ユーザー ID (UNASSIGNED_KEY = 担当なし)。 */
  assignees: ReadonlySet<string>;
  statuses: ReadonlySet<TaskStatus>;
}
/** 担当者の絞り込みで「担当なし」を表す値 (ユーザー ID は空文字列にならない)。 */
export const UNASSIGNED_KEY = "";

/**
 * 絞り込みで残す行 (小文字のタスク ID)。絞り込まないときは null。
 * - 葉タスク: 担当者と状況の両方に合うもの。
 * - 親タスク: 自身の担当者が合う (状況の絞り込みが無いとき)、または残る子孫があるもの。
 * - カテゴリ: 残る子孫があるもの。
 * - マイルストーン (担当・状況を持たない): 同じ親の下に残るタスクがあるもの。
 */
export function filterKeep(ix: TreeIndex, filter: TaskFilter | undefined): Set<string> | null {
  if (!filter || (filter.assignees.size === 0 && filter.statuses.size === 0)) return null;
  const assigneeOk = (ids: readonly string[] | undefined): boolean => {
    if (filter.assignees.size === 0) return true;
    if (!ids || ids.length === 0) return filter.assignees.has(UNASSIGNED_KEY);
    return ids.some((u) => filter.assignees.has(u));
  };
  const keep = new Set<string>();
  // 返り値: その行か子孫にタスクが残るか。
  const visit = (id: string, seen: Set<string>): boolean => {
    const key = idKey(id);
    if (seen.has(key)) return false;
    seen.add(key);
    const task = ix.byId.get(key);
    if (!task || isMilestoneTask(task)) return false;
    const children = getChildren(ix, id);
    let any = false;
    for (const c of children) if (visit(c, seen)) any = true;
    if (!isCategoryTask(task)) {
      const isLeaf = !children.some((c) => !isMilestoneTask(ix.byId.get(idKey(c))));
      if (isLeaf ? assigneeOk(task.assigneeIds) && (filter.statuses.size === 0 || filter.statuses.has(statusOf(task))) : filter.statuses.size === 0 && filter.assignees.size > 0 && assigneeOk(task.assigneeIds)) any = true;
    }
    if (any) {
      keep.add(key);
      for (const c of children) if (isMilestoneTask(ix.byId.get(idKey(c)))) keep.add(idKey(c));
    }
    return any;
  };
  const seen = new Set<string>();
  let anyTop = false;
  const top = getChildren(ix, null);
  for (const id of top) if (visit(id, seen)) anyTop = true;
  if (anyTop) for (const id of top) if (isMilestoneTask(ix.byId.get(idKey(id)))) keep.add(idKey(id));
  return keep;
}

/** 行の ID。異なるスケジュールでタスク ID が重複しても衝突しないよう、スケジュール ID を前に付ける。 */
export const rowKey = (scheduleId: string, taskId: string): string => `${scheduleId}:${taskId}`;
/** プロジェクト見出し行の ID (= スケジュール ID。タスクの行 ID は必ず ":" を含むので衝突しない)。 */
export const projectRowKey = (scheduleId: string): string => scheduleId;
/** 折りたたみの保存キー (タスク ID は大文字小文字を区別しない)。 */
export function collapseKey(rowId: string): string {
  const i = rowId.indexOf(":");
  return i < 0 ? rowId : rowId.slice(0, i + 1) + idKey(rowId.slice(i + 1));
}

/**
 * 1 スケジュールの表示行の順序: 親ごとに「マイルストーン → タスク → サブカテゴリ」(各種別の中の相対順は保つ)。
 * トップレベルだけは既存どおり「カテゴリ → カテゴリなし (マイルストーン → タスク)」。折りたたんだ行の子孫は含めない。
 * `keep` があれば、そこに無い行は含めない (絞り込み)。
 */
export function overviewRowIds(ix: TreeIndex, collapsed: ReadonlySet<string>, keep: ReadonlySet<string> | null = null): string[] {
  const keys = new Set<string>();
  for (const c of collapsed) keys.add(idKey(c));
  const ordered = (parent: string | null): string[] => {
    const cats: string[] = [];
    const ms: string[] = [];
    const rest: string[] = [];
    for (const id of getChildren(ix, parent)) {
      if (keep !== null && !keep.has(idKey(id))) continue;
      const task = ix.byId.get(idKey(id));
      if (isCategoryTask(task)) cats.push(id);
      else if (isMilestoneTask(task)) ms.push(id);
      else rest.push(id);
    }
    return parent === null ? [...cats, ...ms, ...rest] : [...ms, ...rest, ...cats];
  };
  const out: string[] = [];
  const stack = [...ordered(null)].reverse();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    out.push(cur);
    if (keys.has(idKey(cur))) continue;
    const ch = ordered(cur);
    for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]!);
  }
  return out;
}

export interface OverviewLayout {
  layout: Layout;
  /** 一番早いタスクの開始日 (初期スクロール用。無ければ null)。 */
  earliest: IsoDate | null;
  /** 描画できなかったスケジュール (予期しないデータ)。 */
  broken: string[];
}

interface Built {
  p: OverviewProject;
  doc: GanttDocument;
  derived: ReturnType<typeof deriveAll>;
  ix: TreeIndex;
  wc: ReturnType<typeof compileCalendar>;
}

function localCollapsed(collapsed: ReadonlySet<string>, scheduleId: string): Set<string> {
  const prefix = `${scheduleId}:`;
  const out = new Set<string>();
  for (const k of collapsed) if (k.startsWith(prefix)) out.add(k.slice(prefix.length));
  return out;
}

/**
 * 取得済みの複数のスケジュールを 1 つの時間軸のレイアウトにまとめる。
 * 行の階層: プロジェクト > カテゴリ > マイルストーン > タスク。日付計算・集計はスケジュールごとのカレンダー、
 * 背景の網掛けは土日のみ。依存矢印は同じスケジュール内だけ。
 */
export function buildOverviewLayout(input: OverviewInput, today: IsoDate): OverviewLayout {
  const { projects, zoom, valueColumn, collapsed, users, filter } = input;
  const broken: string[] = [];
  const built = new Map<string, Built>();
  let minStart: IsoDate | null = null;
  let maxEnd: IsoDate | null = null;
  for (const p of projects) {
    if (p.state.status !== "ok") continue;
    try {
      const doc = p.state.doc;
      const wc = compileCalendar(doc.project.calendar);
      const derived = deriveAll(doc, wc);
      const [s, e] = taskSpan(derived);
      if (s !== null && (minStart === null || s < minStart)) minStart = s;
      if (e !== null && (maxEnd === null || e > maxEnd)) maxEnd = e;
      built.set(p.id, { p, doc, derived, ix: buildTreeIndex(doc), wc });
    } catch {
      broken.push(p.id);
    }
  }
  const range = rangeAround(minStart, maxEnd, zoom, today);
  const dayWidth = DAY_WIDTH[zoom];

  const rows: RowLayout[] = [];
  const bars: BarLayout[] = [];
  const arrows: ArrowLayout[] = [];
  const heading = (p: OverviewProject, extra: Partial<RowLayout>): RowLayout => ({
    taskId: projectRowKey(p.id),
    index: rows.length,
    rowNo: 0,
    y: rows.length * ROW_HEIGHT,
    depth: 0,
    isParent: false,
    isCategory: false,
    isProject: true,
    href: `/s/${p.id}`,
    status: null,
    done: false,
    overdue: [],
    collapsed: false,
    name: p.name || t("list.untitled"),
    valueText: "",
    assignees: "",
    assigneeLabel: "",
    commentCount: 0,
    ...extra,
  });

  for (const p of projects) {
    const b = built.get(p.id);
    if (p.state.status === "loading") {
      rows.push(heading(p, { note: t("overview.loading"), noteTone: "muted" }));
      continue;
    }
    if (p.state.status === "error") {
      const key = p.state.reason === "notfound" ? "overview.notFound" : p.state.reason === "invalid" ? "overview.renderFailed" : "overview.loadFailed";
      rows.push(heading(p, { note: t(key), noteTone: "error" }));
      continue;
    }
    if (!b) {
      rows.push(heading(p, { note: t("overview.renderFailed"), noteTone: "error" }));
      continue;
    }
    const collapsedHere = localCollapsed(collapsed, p.id);
    const projectCollapsed = collapsed.has(projectRowKey(p.id));
    const keep = filterKeep(b.ix, filter);
    // 絞り込み中は、合うタスクが無いプロジェクトを出さない。
    if (keep !== null && keep.size === 0) continue;
    const hasTasks = b.doc.tasks.length > 0;
    rows.push(heading(p, { isParent: hasTasks, collapsed: projectCollapsed && hasTasks }));
    if (projectCollapsed || !hasTasks) continue;

    let frag: Layout;
    try {
      frag = computeLayout(
        {
          doc: b.doc,
          derived: b.derived,
          wc: b.wc,
          zoom,
          collapsed: collapsedHere,
          valueColumn,
          ix: b.ix,
          rowIds: overviewRowIds(b.ix, collapsedHere, keep),
          users,
          range,
        },
        today,
      );
    } catch {
      broken.push(p.id);
      rows[rows.length - 1] = heading(p, { index: rows.length - 1, y: (rows.length - 1) * ROW_HEIGHT, note: t("overview.renderFailed"), noteTone: "error" });
      continue;
    }
    const offset = rows.length;
    for (const r of frag.rows) {
      rows.push({ ...r, taskId: rowKey(p.id, r.taskId), index: r.index + offset, y: (r.index + offset) * ROW_HEIGHT, depth: r.depth + 1 });
    }
    const barOfRow = new Map<number, BarLayout>();
    for (const bar of frag.bars) {
      const nb = { ...bar, taskId: rowKey(p.id, bar.taskId), rowIndex: bar.rowIndex + offset, y: bar.y + offset * ROW_HEIGHT };
      bars.push(nb);
      barOfRow.set(nb.rowIndex, nb);
    }
    // 矢印の経路は y を含むので、行の位置が変わった分だけ作り直す。
    for (const a of frag.arrows) {
      const from = barOfRow.get(a.fromIndex + offset);
      const to = barOfRow.get(a.toIndex + offset);
      if (!from || !to) continue;
      const y1 = (a.fromIndex + offset) * ROW_HEIGHT + ROW_HEIGHT / 2;
      const y2 = (a.toIndex + offset) * ROW_HEIGHT + ROW_HEIGHT / 2;
      const { d, head } = arrowGeometry(from.x + from.w, y1, to.x, y2, (a.toIndex + offset) * ROW_HEIGHT);
      arrows.push({
        succId: rowKey(p.id, a.succId),
        predId: rowKey(p.id, a.predId),
        fromIndex: a.fromIndex + offset,
        toIndex: a.toIndex + offset,
        d,
        head,
        violated: a.violated,
      });
    }
  }

  const { top, bottom } = buildHeader(range, zoom, dayWidth, WEEKENDS);
  const inRange = today >= range.start && today <= range.end;
  const layout: Layout = {
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
    nonWorking: buildNonWorking(range, zoom, dayWidth, WEEKENDS),
    todayX: inRange ? xOfDate({ range, dayWidth }, today) : null,
  };
  return { layout, earliest: minStart, broken };
}
