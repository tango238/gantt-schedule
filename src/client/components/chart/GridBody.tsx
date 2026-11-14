import { idKey } from "../../../shared/model/id";
import { memo, useCallback } from "react";
import { t } from "../../i18n";
import { COL_ASSIGNEE, COL_NAME, COL_NO, COL_STATUS, COL_VALUE, COLORS, FONT_FAMILY, GRID_WIDTH, INDENT_PX, ROW_HEIGHT, TOGGLE_PX } from "./constants";
import { navigate } from "../../router";
import type { PeerSelection } from "../../store/presence";
import { fitText, type RowLayout } from "./layout";

interface RowProps {
  row: RowLayout;
  selected: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  /** Interactive use only (not needed for static rendering). */
  onEdit?: (id: string, field: "name" | "duration" | "hours") => void;
  valueColumn?: "duration" | "hours";
  /** 他のユーザーがこの行を選択中 (色帯で示す)。 */
  peers?: readonly PeerSelection[];
}

/** Which grid column a mouse event landed in. */
function columnAt(e: { clientX: number; currentTarget: Element }): "no" | "name" | "value" | "status" | "assignee" {
  const svg = (e.currentTarget as SVGElement).ownerSVGElement;
  const x = e.clientX - (svg?.getBoundingClientRect().left ?? 0);
  if (x < COL_NO) return "no";
  if (x < COL_NO + COL_NAME) return "name";
  if (x < COL_NO + COL_NAME + COL_VALUE) return "value";
  return x < COL_NO + COL_NAME + COL_VALUE + COL_STATUS ? "status" : "assignee";
}

/** コメント件数の印 (吹き出し + 件数)。 */
function CommentBadge({ count, x, y }: { count: number; x: number; y: number }) {
  return (
    <g className="comment-badge" data-testid="comment-badge" transform={`translate(${x} ${y})`} pointerEvents="none">
      <title>{t("comments.badgeTitle", { count })}</title>
      <path d="M1 1.5h10a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H6l-2.5 2.5V9H1a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1z" fill="none" stroke={COLORS.textMuted} strokeWidth={1} />
      <text x={16} y={6.5} fontFamily={FONT_FAMILY} fontSize={10} fill={COLORS.textMuted} dominantBaseline="central">
        {count > 99 ? "99+" : count}
      </text>
    </g>
  );
}

const BADGE_W = 32;

/** 「カテゴリなし」の仮想行。doc に無いので選択・編集・コメントできない。 */
const UncategorizedRow = memo(function UncategorizedRow({ row }: { row: RowLayout }) {
  return (
    <g transform={`translate(0 ${row.y})`} data-testid="uncategorized-row" data-virtual-row="">
      <rect x={0} y={0} width={GRID_WIDTH} height={ROW_HEIGHT} fill={COLORS.uncategorizedRow} />
      <line x1={0} x2={GRID_WIDTH} y1={ROW_HEIGHT - 0.5} y2={ROW_HEIGHT - 0.5} stroke={COLORS.border} />
      <text x={COL_NO + 4 + TOGGLE_PX + 2} y={ROW_HEIGHT / 2} fontFamily={FONT_FAMILY} fontSize={12} fill={COLORS.textMuted} fontStyle="italic" dominantBaseline="central">
        {row.name}
      </text>
    </g>
  );
});

/** 全体スケジュールのプロジェクト見出し行 (読み取り専用)。名前はそのスケジュールへのリンク。 */
const ProjectRow = memo(function ProjectRow({ row, onToggle }: { row: RowLayout; onToggle: (id: string) => void }) {
  const mid = ROW_HEIGHT / 2;
  const nameX = COL_NO + 4;
  const tx = nameX + TOGGLE_PX / 2;
  return (
    <g transform={`translate(0 ${row.y})`} data-row-id={row.taskId} data-project="" data-testid="overview-project-row">
      <rect x={0} y={0} width={GRID_WIDTH} height={ROW_HEIGHT} fill={COLORS.projectRow} />
      <rect x={0} y={0} width={6} height={ROW_HEIGHT} fill={COLORS.projectAccent} pointerEvents="none" />
      <line x1={0} x2={GRID_WIDTH} y1={ROW_HEIGHT - 0.5} y2={ROW_HEIGHT - 0.5} stroke={COLORS.border} />
      {row.isParent && (
        <g className="toggle" data-testid="toggle-collapse" onClick={() => onToggle(row.taskId)} style={{ cursor: "pointer" }}>
          <rect x={nameX} y={0} width={TOGGLE_PX} height={ROW_HEIGHT} fill="transparent" />
          <polygon
            fill={COLORS.textMuted}
            points={
              row.collapsed
                ? `${tx - 2.5},${mid - 4} ${tx + 3.5},${mid} ${tx - 2.5},${mid + 4}`
                : `${tx - 4},${mid - 2.5} ${tx + 4},${mid - 2.5} ${tx},${mid + 3.5}`
            }
          />
        </g>
      )}
      <svg x={COL_NO} y={0} width={row.note ? COL_NAME - 40 : COL_NAME} height={ROW_HEIGHT} overflow="hidden">
        <a
          href={row.href}
          onClick={(e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || row.href === undefined) return;
            e.preventDefault();
            navigate(row.href);
          }}
        >
          <title>{row.name}</title>
          <text x={nameX - COL_NO + TOGGLE_PX + 2} y={mid} fontFamily={FONT_FAMILY} fontSize={13} fontWeight={700} fill={COLORS.text} dominantBaseline="central" data-testid="overview-project-name" style={{ cursor: "pointer" }}>
            {fitText(row.name, (row.note ? COL_NAME - 40 : COL_NAME) - TOGGLE_PX - 6 - 8, 14)}
          </text>
        </a>
      </svg>
      {row.note && (
        <text
          x={COL_NO + COL_NAME - 36}
          y={mid}
          fontFamily={FONT_FAMILY}
          fontSize={11}
          fill={row.noteTone === "error" ? COLORS.arrowViolated : COLORS.textMuted}
          dominantBaseline="central"
          data-testid="overview-project-note"
        >
          {row.note}
        </text>
      )}
    </g>
  );
});

const GridRow = memo(function GridRow({ row, selected, onSelect, onToggle, onEdit, valueColumn, peers }: RowProps) {
  if (row.virtual) return <UncategorizedRow row={row} />;
  if (row.isProject) return <ProjectRow row={row} onToggle={onToggle} />;
  const nameX = COL_NO + 4 + row.depth * INDENT_PX;
  const mid = ROW_HEIGHT / 2;
  const tx = nameX + TOGGLE_PX / 2;
  const base = { fontFamily: FONT_FAMILY, fontSize: 12, fill: row.done ? COLORS.textDim : COLORS.text, dominantBaseline: "central" as const };
  const statusX = COL_NO + COL_NAME + COL_VALUE;
  const overdueText = row.overdue.map((r) => t(`status.overdue.${r}`)).join(" / ");
  return (
    <g
      transform={`translate(0 ${row.y})`}
      data-row-id={row.taskId}
      data-category={row.isCategory ? "" : undefined}
      onClick={(e) => {
        // Re-click on the name of an already selected row starts editing (03 section 7).
        if (selected && columnAt(e) === "name") onEdit?.(row.taskId, "name");
        onSelect(row.taskId);
      }}
      onDoubleClick={(e) => {
        const col = columnAt(e);
        if (col === "name") onEdit?.(row.taskId, "name");
        else if (col === "value" && !row.isParent && !row.isCategory && !row.isMilestone) onEdit?.(row.taskId, valueColumn ?? "duration");
      }}
      style={{ cursor: "default" }}
    >
      <rect
        className="row-bg"
        x={0}
        y={0}
        width={GRID_WIDTH}
        height={ROW_HEIGHT}
        fill={selected ? COLORS.selectedRow : row.isCategory ? COLORS.categoryRow : "transparent"}
      />
      {row.isCategory && (
        <rect
          data-testid="category-accent"
          x={0}
          y={0}
          width={4}
          height={ROW_HEIGHT}
          fill={row.color ?? COLORS.categoryDefault}
          pointerEvents="none"
        />
      )}
      {peers?.map((p, i) => (
        <g key={i} pointerEvents="none" data-testid="peer-selection" data-peer-color={p.color}>
          <title>{p.name}</title>
          <rect x={0} y={0} width={GRID_WIDTH} height={ROW_HEIGHT} fill={p.color} fillOpacity={0.1} />
          <rect x={i * 4} y={0} width={4} height={ROW_HEIGHT} fill={p.color} />
        </g>
      ))}
      <line x1={0} x2={GRID_WIDTH} y1={ROW_HEIGHT - 0.5} y2={ROW_HEIGHT - 0.5} stroke={COLORS.border} />
      <text x={COL_NO - 6} y={mid} textAnchor="end" {...base} fill={COLORS.textMuted}>
        {row.rowNo}
      </text>
      {row.isParent && (
        <g
          className="toggle"
          data-testid="toggle-collapse"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(row.taskId);
          }}
          style={{ cursor: "pointer" }}
        >
          <rect x={nameX} y={0} width={TOGGLE_PX} height={ROW_HEIGHT} fill="transparent" />
          <polygon
            fill={COLORS.textMuted}
            points={
              row.collapsed
                ? `${tx - 2.5},${mid - 4} ${tx + 3.5},${mid} ${tx - 2.5},${mid + 4}`
                : `${tx - 4},${mid - 2.5} ${tx + 4},${mid - 2.5} ${tx},${mid + 3.5}`
            }
          />
        </g>
      )}
      <svg x={COL_NO} y={0} width={row.commentCount > 0 ? COL_NAME - BADGE_W : COL_NAME} height={ROW_HEIGHT} overflow="hidden">
        {row.isMilestone && (
          <polygon
            data-testid="grid-milestone-mark"
            points={`${nameX - COL_NO + TOGGLE_PX / 2},${mid - 5} ${nameX - COL_NO + TOGGLE_PX / 2 + 5},${mid} ${nameX - COL_NO + TOGGLE_PX / 2},${mid + 5} ${nameX - COL_NO + TOGGLE_PX / 2 - 5},${mid}`}
            fill={COLORS.milestone}
          />
        )}
        <text
          x={nameX - COL_NO + TOGGLE_PX + 2}
          y={mid}
          {...base}
          fontWeight={row.isParent || row.isCategory ? 700 : 400}
          textDecoration={row.done ? "line-through" : undefined}
          data-testid="grid-name"
          data-done={row.done ? "" : undefined}
        >
          {row.name}
        </text>
      </svg>
      {row.commentCount > 0 && <CommentBadge count={row.commentCount} x={COL_NO + COL_NAME - BADGE_W + 4} y={mid - 6} />}
      <text x={statusX - 6} y={mid} textAnchor="end" {...base}>
        {row.valueText}
      </text>
      {row.status !== null && (
        <g data-testid="grid-status" data-status={row.status}>
          {row.overdue.length > 0 && (
            <g data-testid="overdue-mark" role="img" aria-label={overdueText}>
              <title>{overdueText}</title>
              <circle cx={statusX + 9} cy={mid} r={6} fill={COLORS.arrowViolated} />
              <text x={statusX + 9} y={mid + 0.5} textAnchor="middle" fontFamily={FONT_FAMILY} fontSize={10} fontWeight={700} fill="#fff" dominantBaseline="central">
                !
              </text>
            </g>
          )}
          <text x={statusX + (row.overdue.length > 0 ? 19 : 6)} y={mid} {...base} fontSize={11}>
            {t(`status.label.${row.status}`)}
          </text>
        </g>
      )}
      {row.assigneeLabel !== "" && (
        <text x={GRID_WIDTH - COL_ASSIGNEE + 6} y={mid} {...base} data-testid="assignee-cell">
          <title>{row.assignees}</title>
          {row.assigneeLabel}
        </text>
      )}
    </g>
  );
});

interface Props {
  rows: readonly RowLayout[];
  bodyHeight: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  /** Interactive use only (not needed for static rendering). */
  onEdit?: (id: string, field: "name" | "duration" | "hours") => void;
  valueColumn?: "duration" | "hours";
  /** idKey -> 他のユーザーの選択。 */
  peers?: ReadonlyMap<string, readonly PeerSelection[]>;
}

function GridBodyImpl({ rows, bodyHeight, selectedId, onSelect, onToggle, onEdit, valueColumn, peers }: Props) {
  const sel = selectedId !== null ? idKey(selectedId) : null;
  const select = useCallback((id: string) => onSelect(id), [onSelect]);
  return (
    <svg
      className="grid-body"
      width={GRID_WIDTH}
      height={bodyHeight}
      style={{ position: "sticky", left: 0, zIndex: 1, display: "block", background: "#fff" }}
    >
      {rows.map((r) => (
        <GridRow
          key={r.taskId}
          row={r}
          selected={sel !== null && idKey(r.taskId) === sel}
          onSelect={select}
          onToggle={onToggle}
          onEdit={onEdit}
          valueColumn={valueColumn}
          peers={peers?.get(idKey(r.taskId))}
        />
      ))}
      <line x1={GRID_WIDTH - 0.5} x2={GRID_WIDTH - 0.5} y1={0} y2={bodyHeight} stroke={COLORS.border} />
    </svg>
  );
}

export const GridBody = memo(GridBodyImpl);
