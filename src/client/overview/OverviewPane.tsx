import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { addDays, diffDays } from "../../shared/model/date";
import { clampPaneHeight, maxPaneHeight } from "../ai/paneSize";
import { COLORS, FONT_FAMILY, GRID_WIDTH, HEADER_HEIGHT } from "../components/chart/constants";
import { GridBody } from "../components/chart/GridBody";
import { GridHeader } from "../components/chart/GridHeader";
import { TimelineBody } from "../components/chart/TimelineBody";
import { TimelineHeader } from "../components/chart/TimelineHeader";
import { xOfDate } from "../components/chart/layout";
import { PaneResizer } from "../components/PaneResizer";
import { ZoomControl } from "../components/ZoomSwitch";
import { t } from "../i18n";
import type { ScheduleListItem } from "../schedulesApi";
import { loadUsers, refreshIfUnknown, useUsersStore } from "../users/usersStore";
import { useToday } from "../useToday";
import "../styles/chart.css";
import type { TaskStatus } from "../../shared/model/types";
import { FilterMenu, type FilterOption } from "./FilterMenu";
import { buildOverviewLayout, collapseKey, UNASSIGNED_KEY, type OverviewProject, type TaskFilter } from "./merge";
import { loadView, pruneCollapsed, saveView, STATUSES, type OverviewView } from "./storage";
import { useOverviewDocs } from "./useOverviewDocs";

const scrollStyle = {
  fontFamily: FONT_FAMILY,
  color: COLORS.text,
  "--row-hover": COLORS.hoverRow,
} as CSSProperties;

const noop = () => {};

function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

interface Props {
  /** 一覧のすべてのスケジュール (一覧の並び順)。プロジェクトの絞り込みの選択肢になる。 */
  items: readonly ScheduleListItem[];
  /** 表示するスケジュールの ID (プロジェクトの絞り込み)。 */
  selected: readonly string[];
  onSelectedChange: (ids: string[]) => void;
  /** 一覧にあるスケジュールの ID (存在しないものの折りたたみ状態を捨てる)。 */
  knownIds?: ReadonlySet<string>;
}

/**
 * 一覧ページ下部の「全体スケジュール」(読み取り専用)。プロジェクト > カテゴリ > マイルストーン > タスク。
 * プロジェクト・担当者・状況で絞り込める。プロジェクトは選んだものだけ取得して表示し、担当者・状況は未選択なら絞り込まない。
 */
export function OverviewPane({ items: all, selected, onSelectedChange, knownIds }: Props) {
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const items = useMemo(() => all.filter((s) => selectedSet.has(s.id)), [all, selectedSet]);
  const [view, setView] = useState<OverviewView>(loadView);
  const [winH, setWinH] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setWinH(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const viewRef = useRef(view);
  viewRef.current = view;
  const update = useCallback((patch: Partial<OverviewView>, persist = true) => {
    const next = { ...viewRef.current, ...patch };
    viewRef.current = next;
    setView(next);
    if (persist) saveView(next);
  }, []);

  useEffect(() => {
    if (!knownIds) return;
    const kept = pruneCollapsed(viewRef.current.collapsed, knownIds);
    if (kept.length !== viewRef.current.collapsed.length) update({ collapsed: kept });
  }, [knownIds, update]);

  const ids = useMemo(() => items.map((s) => s.id), [items]);
  const { docs, fetchedAt, busy, refresh } = useOverviewDocs(ids);
  const names = useUsersStore((s) => s.names);
  const today = useToday();
  useEffect(() => {
    void loadUsers();
  }, []);
  useEffect(() => {
    const assignees: string[] = [];
    for (const d of docs.values()) {
      if (d.status === "ok") for (const task of d.doc.tasks) if (Array.isArray(task.assigneeIds)) assignees.push(...task.assigneeIds);
    }
    if (assignees.length > 0) void refreshIfUnknown(assignees);
  }, [docs]);

  const projects = useMemo<OverviewProject[]>(
    () =>
      items.map((s) => {
        const d = docs.get(s.id) ?? { status: "loading" as const };
        return d.status === "ok"
          ? { id: s.id, name: d.name, state: { status: "ok", doc: d.doc } }
          : { id: s.id, name: s.name, state: d };
      }),
    [items, docs],
  );
  const collapsed = useMemo(() => new Set(view.collapsed), [view.collapsed]);
  const filter = useMemo<TaskFilter>(
    () => ({ assignees: new Set(view.assignees), statuses: new Set(view.statuses) }),
    [view.assignees, view.statuses],
  );
  const filtering = filter.assignees.size > 0 || filter.statuses.size > 0;
  const { layout, earliest } = useMemo(
    () => buildOverviewLayout({ projects, zoom: view.zoom, valueColumn: view.valueColumn, collapsed, users: names, filter }, today),
    [projects, view.zoom, view.valueColumn, collapsed, names, filter, today],
  );

  const projectOptions = useMemo<FilterOption[]>(() => all.map((s) => ({ value: s.id, label: s.name || t("list.untitled") })), [all]);
  // 担当者の選択肢: 表示中のスケジュールに出てくる人 + 選択済みの人 (外せるように残す)。
  const assigneeOptions = useMemo<FilterOption[]>(() => {
    const ids = new Set<string>(view.assignees);
    for (const d of docs.values()) {
      if (d.status === "ok") for (const task of d.doc.tasks) for (const u of task.assigneeIds ?? []) ids.add(u);
    }
    ids.delete(UNASSIGNED_KEY);
    const people = [...ids]
      .map((id) => ({ value: id, label: names?.get(id) ?? t("assignee.unknown") }))
      .sort((a, b) => a.label.localeCompare(b.label, "ja") || (a.value < b.value ? -1 : 1));
    return [{ value: UNASSIGNED_KEY, label: t("overview.filter.unassigned") }, ...people];
  }, [docs, names, view.assignees]);
  const statusOptions = useMemo<FilterOption[]>(() => STATUSES.map((s) => ({ value: s, label: t(`status.label.${s}`) })), []);

  const onToggle = useCallback(
    (rowId: string) => {
      const key = collapseKey(rowId);
      const cur = viewRef.current.collapsed;
      update({ collapsed: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] });
    },
    [update],
  );
  const toggleValueColumn = useCallback(
    () => update({ valueColumn: viewRef.current.valueColumn === "duration" ? "hours" : "duration" }),
    [update],
  );

  // スクロール位置: 初めてタスクが出たときは一番早い日付へ。ズームや表示範囲が変わったら同じ日付を保つ。
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastScrollLeft = useRef(0);
  const prev = useRef<{ zoom: string; start: string; dayWidth: number; placed: boolean } | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      prev.current = null; // 表示するものが無い間はスクロール領域が無い。次に出たときに置き直す。
      return;
    }
    const p = prev.current;
    let placed = p?.placed ?? false;
    if (!placed && earliest !== null) {
      el.scrollLeft = Math.max(0, xOfDate(layout, earliest) - layout.dayWidth);
      placed = true;
    } else if (p && p.zoom !== layout.zoom) {
      el.scrollLeft = Math.max(0, xOfDate(layout, addDays(p.start, Math.floor(lastScrollLeft.current / p.dayWidth))));
    } else if (p && p.start !== layout.range.start) {
      el.scrollLeft = Math.max(0, el.scrollLeft + diffDays(layout.range.start, p.start) * layout.dayWidth);
    }
    lastScrollLeft.current = el.scrollLeft;
    prev.current = { zoom: layout.zoom, start: layout.range.start, dayWidth: layout.dayWidth, placed };
  }, [layout, earliest]);
  const onScroll = useCallback(() => {
    if (scrollRef.current) lastScrollLeft.current = scrollRef.current.scrollLeft;
  }, []);

  // 高さ: ウィンドウが小さいときは表示だけ収める (保存値は操作するまで書き換えない)。
  const shown = clampPaneHeight(view.height, winH);

  // プロジェクトが選ばれていなければ、見出しの帯だけ出す (一覧を狭くしない)。
  // 絞り込みの一覧を開いたまま選べるよう、どちらの場合も同じ要素の並びにする。
  const empty = items.length === 0;

  return (
    <section
      className={empty ? "overview-pane overview-pane-empty" : "overview-pane"}
      style={empty ? undefined : { height: shown }}
      aria-label={t("overview.title")}
      aria-busy={busy}
      data-testid="overview-pane"
    >
      {!empty && (
        <PaneResizer
          height={shown}
          max={maxPaneHeight(winH)}
          label={t("overview.resize")}
          testId="overview-resize"
          onChange={(h) => update({ height: clampPaneHeight(h, window.innerHeight) }, false)}
          onCommit={() => saveView(viewRef.current)}
        />
      )}
      <div className="overview-header">
        <span className="overview-title">{t("overview.title")}</span>
        <FilterMenu name="project" label={t("overview.filter.project")} options={projectOptions} selected={selectedSet} onChange={onSelectedChange} />
        {empty && <span className="overview-hint" data-testid="overview-hint">{t("overview.noProjects")}</span>}
        {!empty && (
          <>
            <FilterMenu
              name="assignee"
              label={t("overview.filter.assignee")}
              options={assigneeOptions}
              selected={filter.assignees}
              onChange={(assignees) => update({ assignees })}
            />
            <FilterMenu
              name="status"
              label={t("overview.filter.status")}
              options={statusOptions}
              selected={filter.statuses}
              onChange={(v) => update({ statuses: STATUSES.filter((s) => v.includes(s)) as TaskStatus[] })}
            />
            <span className="overview-spacer" />
            <span className="overview-fetched" data-testid="overview-fetched">
              {busy ? t("overview.fetching") : fetchedAt !== null ? t("overview.fetchedAt", { time: formatTime(fetchedAt) }) : ""}
            </span>
            <button type="button" onClick={refresh} disabled={busy} data-testid="overview-refresh">
              {t("overview.refresh")}
            </button>
            <ZoomControl zoom={view.zoom} onChange={(zoom) => update({ zoom })} />
          </>
        )}
      </div>
      {!empty && (
        <div className="chart-scroll overview-scroll" ref={scrollRef} onScroll={onScroll} style={scrollStyle} data-testid="overview-scroll">
          <div
            className="chart-grid"
            style={{
              display: "grid",
              gridTemplateColumns: `${GRID_WIDTH}px ${layout.timelineWidth}px`,
              gridTemplateRows: `${HEADER_HEIGHT}px ${layout.bodyHeight}px`,
              width: GRID_WIDTH + layout.timelineWidth,
            }}
          >
            <GridHeader valueColumn={view.valueColumn} onToggleValueColumn={toggleValueColumn} />
            <TimelineHeader width={layout.timelineWidth} top={layout.headerTop} bottom={layout.headerBottom} />
            <div className="grid-body-wrap" style={{ position: "sticky", left: 0, zIndex: 1 }}>
              <GridBody
                rows={layout.rows}
                bodyHeight={layout.bodyHeight}
                selectedId={null}
                onSelect={noop}
                onToggle={onToggle}
                valueColumn={view.valueColumn}
              />
            </div>
            <TimelineBody layout={layout} selectedId={null} selectedDependency={null} onSelect={noop} onSelectDependency={noop} />
          </div>
          {filtering && layout.rows.length === 0 && (
            <p className="overview-nomatch" data-testid="overview-nomatch">{t("overview.noMatch")}</p>
          )}
        </div>
      )}
    </section>
  );
}
