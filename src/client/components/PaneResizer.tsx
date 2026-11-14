import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { MIN_PANE_HEIGHT } from "../ai/paneSize";

const KEY_STEP = 24;

interface Props {
  /** 今表示している高さ (px)。 */
  height: number;
  /** 高さの上限 (px)。 */
  max: number;
  label: string;
  testId: string;
  /** ドラッグ・キー操作中に高さが変わるたび。 */
  onChange: (h: number) => void;
  /** 保存のタイミング (ドラッグの終了・キー操作)。 */
  onCommit: () => void;
}

/** ペイン上端の高さ変更つまみ (AI ペインと全体スケジュールのペインで共通)。上へドラッグすると高くなる。 */
export function PaneResizer({ height, max, label, testId, onChange, onCommit }: Props) {
  const drag = useRef<{ y: number; h: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, h: height };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) onChange(drag.current.h - (e.clientY - drag.current.y));
  };
  const endDrag = () => {
    if (drag.current) onCommit(); // 保存はドラッグの終了時だけ
    drag.current = null;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    onChange(height + dir * KEY_STEP);
    onCommit();
  };
  return (
    <div
      className="ai-resize"
      role="separator"
      aria-orientation="horizontal"
      aria-valuenow={height}
      aria-valuemin={MIN_PANE_HEIGHT}
      aria-valuemax={Math.max(MIN_PANE_HEIGHT, max)}
      aria-label={label}
      tabIndex={0}
      title={label}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}
