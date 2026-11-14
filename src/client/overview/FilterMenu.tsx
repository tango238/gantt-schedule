import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { t } from "../i18n";

export interface FilterOption {
  value: string;
  label: string;
}

interface Props {
  /** テスト ID・要素 ID の接尾辞 (project / assignee / status)。 */
  name: string;
  label: string;
  options: readonly FilterOption[];
  selected: ReadonlySet<string>;
  onChange: (next: string[]) => void;
}

/** チェックボックスで複数選ぶ絞り込み (ボタンを押すと一覧が開く)。 */
export function FilterMenu({ name, label, options, selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // ペインはページの下端にあるので、広い側 (上か下) に開く。
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const r = buttonRef.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 268));
    setPos(
      below >= 240 || below >= above
        ? { left, top: r.bottom + 2, maxHeight: Math.max(120, below) }
        : { left, bottom: window.innerHeight - r.top + 2, maxHeight: Math.max(120, above) },
    );
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const count = options.filter((o) => selected.has(o.value)).length;
  const toggle = (value: string) =>
    onChange(selected.has(value) ? [...selected].filter((v) => v !== value) : [...selected, value]);

  return (
    <div className="overview-filter" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={count > 0 ? "active" : ""}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid={`overview-filter-${name}`}
      >
        {count > 0 ? t("overview.filter.count", { label, count }) : label}
        <span aria-hidden="true" className="overview-filter-caret">▾</span>
      </button>
      {open && (
        <div className="overview-filter-menu" role="group" aria-label={label} style={pos} data-testid={`overview-filter-${name}-menu`}>
          <div className="overview-filter-actions">
            <button type="button" disabled={options.length === 0 || count === options.length} onClick={() => onChange(options.map((o) => o.value))} data-testid="filter-select-all">
              {t("overview.filter.selectAll")}
            </button>
            <button type="button" disabled={selected.size === 0} onClick={() => onChange([])} data-testid="filter-clear">
              {t("overview.filter.clear")}
            </button>
          </div>
          {options.length === 0 ? (
            <p className="overview-filter-empty">{t("overview.filter.empty")}</p>
          ) : (
            <ul>
              {options.map((o) => (
                <li key={o.value}>
                  <label title={o.label}>
                    <input type="checkbox" checked={selected.has(o.value)} onChange={() => toggle(o.value)} data-testid="filter-option" data-value={o.value} />
                    <span>{o.label}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
