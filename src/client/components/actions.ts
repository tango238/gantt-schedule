// Executes keymap Actions / toolbar commands against the store. Command errors become toasts.
import {
  getChildren,
  getDescendants,
  movableNext,
  movablePrevious,
  previousSibling,
  type Command,
} from "../../shared/engine";
import { t } from "../i18n";
import { idKey } from "../../shared/model/id";
import { useAppStore, type CommandResult } from "../store/appStore";
import { selectVisibleRowIds, treeIndexOf, visibleAncestorOf } from "../store/selectors";
import type { Action } from "./keymap";
import { requestConfirm, showCommandError, showToast } from "./uiStore";

/** Dispatch a command; a rejected command is reported as a toast. */
export function runCommand(cmd: Command): CommandResult {
  const res = useAppStore.getState().dispatch(cmd);
  if (!res.ok) {
    // バージョン表示中の READ_ONLY は「切断中」とは別の理由なので、文言を分ける。
    if (res.code === "READ_ONLY" && useAppStore.getState().viewing !== null) showToast("error", t("versions.readOnlyToast"));
    else showCommandError(res);
  }
  return res;
}

/** Delete the selected dependency or task; a parent asks for confirmation first (03 section 11.4). */
export function deleteSelection(): void {
  const s = useAppStore.getState();
  if (s.doc === null) return;
  if (s.selectedDependency) {
    runCommand({ type: "removeDependency", ...s.selectedDependency });
    return;
  }
  const id = s.selectedId;
  if (id === null) return;
  const ix = treeIndexOf(s.doc);
  const task = ix.byId.get(idKey(id));
  if (!task) return;
  if (getChildren(ix, id).length > 0) {
    requestConfirm({
      message: t("dialog.confirmDeleteParent", { name: task.name, count: getDescendants(ix, id).length }),
      confirmLabel: t("dialog.delete"),
      onConfirm: () => {
        runCommand({ type: "deleteTask", id });
      },
    });
    return;
  }
  runCommand({ type: "deleteTask", id });
}

/** Enabled state of the selection-dependent buttons (03 section 8.1). */
export interface SelectionCaps {
  hasSelection: boolean;
  canIndent: boolean;
  canOutdent: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
}
export function selectionCaps(
  doc: Parameters<typeof treeIndexOf>[0] | null,
  selectedId: string | null,
): SelectionCaps {
  const none = { hasSelection: false, canIndent: false, canOutdent: false, canMoveUp: false, canMoveDown: false };
  if (!doc || selectedId === null) return none;
  const ix = treeIndexOf(doc);
  const task = ix.byId.get(idKey(selectedId));
  if (!task) return none;
  const prev = previousSibling(ix, selectedId);
  return {
    hasSelection: true,
    // カテゴリ・マイルストーンは直前の兄弟がカテゴリのときだけインデントできる。マイルストーンの下には何も置けない。
    canIndent:
      prev !== null &&
      ix.byId.get(idKey(prev))?.kind !== "milestone" &&
      (task.kind !== "category" && task.kind !== "milestone" ? true : ix.byId.get(idKey(prev))?.kind === "category"),
    canOutdent: (task.parentId ?? null) !== null,
    canMoveUp: movablePrevious(ix, selectedId) !== null,
    canMoveDown: movableNext(ix, selectedId) !== null,
  };
}

/** Execute one keymap action. */
export function performAction(a: Action): void {
  const s = useAppStore.getState();
  if (s.doc === null) return;
  const sel = s.selectedId;

  switch (a.type) {
    case "addTask":
      runCommand({ type: "addTask", afterId: sel });
      return;
    case "addCategory":
      runCommand({ type: "addCategory", afterId: sel });
      return;
    case "addMilestone":
      runCommand({ type: "addMilestone", afterId: sel });
      return;
    case "editName":
      if (sel !== null) {
        // A selection hidden by a collapsed ancestor has no row to edit: move to the visible ancestor.
        const target = visibleAncestorOf(s.doc, sel);
        if (idKey(target) !== idKey(sel)) s.select(target);
        s.setEditing({ taskId: target, field: "name" });
      }
      return;
    case "deleteSelected":
      deleteSelection();
      return;
    case "indent":
    case "outdent":
    case "moveUp":
    case "moveDown":
    case "duplicate":
      if (sel !== null) runCommand({ type: a.type === "duplicate" ? "duplicateTask" : a.type, id: sel });
      return;
    case "selectPrev":
    case "selectNext": {
      const rows = selectVisibleRowIds(s);
      if (rows.length === 0) return;
      // A selection hidden by a collapsed ancestor navigates from that ancestor's row.
      const from = sel === null ? null : visibleAncestorOf(s.doc, sel);
      const i = from === null ? -1 : rows.findIndex((r) => idKey(r) === idKey(from));
      const next = a.type === "selectPrev" ? (i < 0 ? rows.length - 1 : i - 1) : i + 1;
      const id = rows[Math.min(rows.length - 1, Math.max(0, next))];
      if (id !== undefined) s.select(id);
      return;
    }
    case "collapse": {
      if (sel === null) return;
      const ix = treeIndexOf(s.doc);
      const collapsed = (s.doc.view?.collapsedTaskIds ?? []).some((c) => idKey(c) === idKey(sel));
      if (getChildren(ix, sel).length > 0 && !collapsed) {
        s.toggleCollapsed(sel);
      } else {
        const parent = ix.parentOf.get(idKey(sel));
        if (parent) s.select(parent);
      }
      return;
    }
    case "expand": {
      if (sel === null) return;
      const ix = treeIndexOf(s.doc);
      const collapsed = (s.doc.view?.collapsedTaskIds ?? []).some((c) => idKey(c) === idKey(sel));
      if (getChildren(ix, sel).length > 0 && collapsed) s.toggleCollapsed(sel);
      return;
    }
    case "zoom":
      s.setZoom(a.zoom);
      return;
    case "escape":
      if (s.selectedDependency) s.selectDependency(null);
      return;
  }
}
