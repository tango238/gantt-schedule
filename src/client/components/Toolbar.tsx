import type { ReactNode } from "react";
import { t } from "../i18n";
import { idKey } from "../../shared/model/id";
import { useAppStore } from "../store/appStore";
import { selectionCaps, runCommand, deleteSelection } from "./actions";
import {
  IconAdd,
  IconAddCategory,
  IconAddMilestone,
  IconDelete,
  IconDuplicate,
  IconIndent,
  IconMoveDown,
  IconMoveUp,
  IconOutdent,
  IconSidePanel,
  IconSwap,
} from "./icons";
import { detectPlatform, formatShortcut } from "./keymap";

interface BtnProps {
  id: string;
  shortcut?: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick?: () => void;
  children: ReactNode;
}

const platform = detectPlatform();

function Btn({ id, shortcut, disabled, pressed, onClick, children }: BtnProps) {
  const label = t(`toolbar.${id}`);
  const title = shortcut ? `${label} (${formatShortcut(platform, shortcut)})` : label;
  return (
    <button
      type="button"
      className={`tb-btn${pressed ? " active" : ""}`}
      data-testid={`tb-${id}`}
      title={title}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled || !onClick}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const Sep = () => <span className="tb-sep" role="separator" />;

/** Toolbar (03 section 8.1). */
export function Toolbar() {
  const doc = useAppStore((s) => s.doc);
  const selectedId = useAppStore((s) => s.selectedId);
  const selectedDependency = useAppStore((s) => s.selectedDependency);
  const valueColumn = useAppStore((s) => s.valueColumn);
  const sidePanelOpen = useAppStore((s) => s.sidePanelOpen);
  const setValueColumn = useAppStore((s) => s.setValueColumn);
  const setSidePanelOpen = useAppStore((s) => s.setSidePanelOpen);

  const readOnly = useAppStore((s) => s.readOnly);
  const hasDoc = doc !== null && !readOnly;
  const caps = readOnly
    ? { hasSelection: false, canIndent: false, canOutdent: false, canMoveUp: false, canMoveDown: false }
    : selectionCaps(doc, selectedId);
  const withSel = (type: "duplicateTask" | "indent" | "outdent" | "moveUp" | "moveDown") => () => {
    if (selectedId !== null) runCommand({ type, id: selectedId });
  };
  const currentColor = (selectedId !== null && doc?.tasks.find((x) => idKey(x.id) === idKey(selectedId))?.colorLabelId) || "";

  return (
    <div
      className="toolbar"
      role="toolbar"
      // Keep focus where it is (so Enter / Delete keep working on the chart); selects need focus.
      onMouseDown={(e) => {
        if (!(e.target instanceof Element && e.target.closest("select"))) {
          // preventDefault keeps focus (so no blur happens): commit a pending inline edit first.
          const active = document.activeElement;
          if (active instanceof HTMLElement && active.classList.contains("inline-editor")) active.blur();
          e.preventDefault();
        }
      }}
    >
      <Btn id="addTask" shortcut="Enter" disabled={!hasDoc} onClick={() => runCommand({ type: "addTask", afterId: selectedId })}>
        <IconAdd />
      </Btn>
      <Btn id="addCategory" shortcut="Shift+Enter" disabled={!hasDoc} onClick={() => runCommand({ type: "addCategory", afterId: selectedId })}>
        <IconAddCategory />
      </Btn>
      <Btn id="addMilestone" shortcut="Alt+Enter" disabled={!hasDoc} onClick={() => runCommand({ type: "addMilestone", afterId: selectedId })}>
        <IconAddMilestone />
      </Btn>
      <Btn id="deleteTask" shortcut="Delete" disabled={readOnly || (!caps.hasSelection && !selectedDependency)} onClick={deleteSelection}>
        <IconDelete />
      </Btn>
      <Btn id="duplicate" shortcut="Mod+D" disabled={!caps.hasSelection} onClick={withSel("duplicateTask")}>
        <IconDuplicate />
      </Btn>
      <Sep />
      <Btn id="indent" shortcut="Tab" disabled={!caps.canIndent} onClick={withSel("indent")}>
        <IconIndent />
      </Btn>
      <Btn id="outdent" shortcut="Shift+Tab" disabled={!caps.canOutdent} onClick={withSel("outdent")}>
        <IconOutdent />
      </Btn>
      <Btn id="moveUp" shortcut="Alt+↑" disabled={!caps.canMoveUp} onClick={withSel("moveUp")}>
        <IconMoveUp />
      </Btn>
      <Btn id="moveDown" shortcut="Alt+↓" disabled={!caps.canMoveDown} onClick={withSel("moveDown")}>
        <IconMoveDown />
      </Btn>
      <Sep />
      <select
        className="tb-select"
        data-testid="tb-colorLabel"
        title={t("toolbar.colorLabel")}
        aria-label={t("toolbar.colorLabel")}
        disabled={!caps.hasSelection}
        value={currentColor}
        onChange={(e) => {
          if (selectedId !== null) {
            runCommand({ type: "setColorLabel", id: selectedId, colorLabelId: e.target.value === "" ? null : e.target.value });
          }
          e.target.blur();
        }}
      >
        <option value="">{t("toolbar.colorLabelNone")}</option>
        {(doc?.colorLabels ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <Btn
        id="toggleValueColumn"
        pressed={valueColumn === "hours"}
        onClick={() => setValueColumn(valueColumn === "duration" ? "hours" : "duration")}
      >
        <IconSwap />
      </Btn>
      <span className="tb-spacer" />
      <Btn id="toggleSidePanel" pressed={sidePanelOpen} onClick={() => setSidePanelOpen(!sidePanelOpen)}>
        <IconSidePanel />
      </Btn>
    </div>
  );
}
