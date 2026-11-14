import { idKey } from "../../../shared/model/id";
import { memo } from "react";
import { COLORS, FONT_FAMILY, BAR_HEIGHT, MILESTONE_HALF, ROW_HEIGHT, SUMMARY_HEIGHT } from "./constants";
import type { BarLayout } from "./layout";

interface BarProps {
  bar: BarLayout;
  linkHandle: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
}

/** Dependency-link handle, shown while the bar is hovered (03 section 6.1). */
function LinkHandle({ bar }: { bar: BarLayout }) {
  const cx = bar.x + bar.w + 8;
  const cy = bar.rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
  return (
    <g className="link-handle" data-link-handle="">
      <rect x={bar.x + bar.w} y={cy - 6} width={14} height={12} fill="transparent" />
      <circle cx={cx} cy={cy} r={4} fill="#fff" stroke={COLORS.selection} strokeWidth={1.5} />
      <circle cx={cx} cy={cy} r={6} fill="transparent" />
    </g>
  );
}

const labelStyle = { fontFamily: FONT_FAMILY, fontSize: 11, fill: COLORS.label, dominantBaseline: "central" as const };

const LeafBar = memo(function LeafBar({ bar, linkHandle, selected, onSelect }: BarProps) {
  const clipId = `bar-clip-${bar.taskId}`;
  const cy = bar.y + BAR_HEIGHT / 2;
  // 完了はグレー。未着手は薄く、進行中は濃く塗る。
  const fill = bar.done ? COLORS.doneGray : bar.color;
  const opacity = bar.done ? 0.7 : bar.status === "doing" ? 1 : 0.5;
  return (
    <g data-task-id={bar.taskId} data-kind="leaf" data-status={bar.status ?? undefined} data-done={bar.done ? "" : undefined} data-overdue={bar.overdue ? "" : undefined} className="bar-group" onClick={() => onSelect(bar.taskId)}>
      <clipPath id={clipId}>
        <rect x={bar.x} y={bar.y} width={bar.w} height={BAR_HEIGHT} rx={3} />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        <rect x={bar.x} y={bar.y} width={bar.w} height={BAR_HEIGHT} fill={fill} fillOpacity={opacity} />
      </g>
      {bar.overdue && (
        <rect
          data-testid="bar-overdue"
          x={bar.x}
          y={bar.y}
          width={bar.w}
          height={BAR_HEIGHT}
          rx={3}
          fill="none"
          stroke={COLORS.arrowViolated}
          strokeWidth={2}
          pointerEvents="none"
        />
      )}
      {selected && (
        <rect
          x={bar.x - (bar.overdue ? 2 : 0)}
          y={bar.y - (bar.overdue ? 2 : 0)}
          width={bar.w + (bar.overdue ? 4 : 0)}
          height={BAR_HEIGHT + (bar.overdue ? 4 : 0)}
          rx={3}
          fill="none"
          stroke={COLORS.selection}
          strokeWidth={2}
        />
      )}
      {(bar.assigneeText || bar.resourceText) && (
        <text x={bar.labelX} y={cy} style={{ ...labelStyle, pointerEvents: "none" }} fillOpacity={bar.done ? 0.6 : 1}>
          {/* 担当者を先に、続けてリソース。 */}
          {bar.assigneeText && <tspan data-testid="bar-assignees">{bar.assigneeText}</tspan>}
          {bar.resourceText && <tspan dx={bar.assigneeText ? 8 : 0}>{bar.resourceText}</tspan>}
        </text>
      )}
      {linkHandle && <LinkHandle bar={bar} />}
    </g>
  );
});

const SummaryBar = memo(function SummaryBar({ bar, linkHandle, selected, onSelect }: BarProps) {
  const { x, w, y: y0 } = bar;
  const fill = bar.done ? COLORS.doneGray : bar.color;
  return (
    <g data-task-id={bar.taskId} data-kind="summary" data-done={bar.done ? "" : undefined} className="bar-group" onClick={() => onSelect(bar.taskId)}>
      <rect x={x} y={y0} width={w} height={SUMMARY_HEIGHT} fill={fill} fillOpacity={bar.done ? 0.6 : 0.9} />
      <polygon fill={fill} points={`${x},${y0 + SUMMARY_HEIGHT} ${x + 7},${y0 + SUMMARY_HEIGHT} ${x},${y0 + SUMMARY_HEIGHT + 6}`} />
      <polygon
        fill={fill}
        points={`${x + w},${y0 + SUMMARY_HEIGHT} ${x + w - 7},${y0 + SUMMARY_HEIGHT} ${x + w},${y0 + SUMMARY_HEIGHT + 6}`}
      />
      {selected && (
        <rect
          x={x - 1}
          y={y0 - 1}
          width={w + 2}
          height={SUMMARY_HEIGHT + 2}
          fill="none"
          stroke={COLORS.selection}
          strokeWidth={2}
        />
      )}
      {bar.resourceText && (
        <text x={bar.labelX} y={y0 + 6} style={{ ...labelStyle, pointerEvents: "none" }}>
          {bar.resourceText}
        </text>
      )}
      {linkHandle && <LinkHandle bar={bar} />}
    </g>
  );
});

/** マイルストーン: 日付のマスの中央にひし形、右に名前 (色ラベルの色)。依存線の起点・終点・リサイズの対象にならない。 */
const MilestoneBar = memo(function MilestoneBar({ bar, selected, onSelect }: BarProps) {
  const cx = bar.x + bar.w / 2;
  const cy = bar.y + BAR_HEIGHT / 2;
  const r = MILESTONE_HALF;
  return (
    <g data-task-id={bar.taskId} data-kind="milestone" className="bar-group" onClick={() => onSelect(bar.taskId)}>
      <polygon
        data-testid="milestone-diamond"
        points={`${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`}
        fill={bar.color}
        stroke={selected ? COLORS.selection : "#fff"}
        strokeWidth={selected ? 2 : 1}
      />
      <text x={bar.labelX} y={cy} style={{ ...labelStyle, fill: bar.color, fontWeight: 600, pointerEvents: "none" }} data-testid="milestone-label">
        {bar.label}
      </text>
    </g>
  );
});

interface Props {
  bars: readonly BarLayout[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Show the hover link handle (interactive chart only). */
  linkHandles?: boolean;
}

function BarsImpl({ bars, selectedId, onSelect, linkHandles = false }: Props) {
  const sel = selectedId !== null ? idKey(selectedId) : null;
  return (
    <g className="bars">
      {bars.map((b) => {
        const selected = sel !== null && idKey(b.taskId) === sel;
        if (b.kind === "milestone") {
          return <MilestoneBar key={b.taskId} bar={b} linkHandle={false} selected={selected} onSelect={onSelect} />;
        }
        return b.kind === "leaf" ? (
          <LeafBar key={b.taskId} bar={b} linkHandle={linkHandles} selected={selected} onSelect={onSelect} />
        ) : (
          <SummaryBar key={b.taskId} bar={b} linkHandle={linkHandles} selected={selected} onSelect={onSelect} />
        );
      })}
    </g>
  );
}

export const Bars = memo(BarsImpl);
