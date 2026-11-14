import { useMemo, useState } from "react";
import { getAncestors, getDescendants } from "../../../shared/engine";
import { t } from "../../i18n";
import { idKey } from "../../../shared/model/id";
import { useAppStore } from "../../store/appStore";
import { derivedOf, displayDoc, serialNosOf, treeIndexOf } from "../../store/selectors";
import { runCommand } from "../actions";

/**
 * Predecessor list + add form (03 section 9.1). Candidates exclude the task itself, its
 * ancestors / descendants and existing predecessors; cycles are rejected by the engine (toast).
 */
export function PredecessorEditor({ taskId }: { taskId: string }) {
  const doc = useAppStore(displayDoc);
  const [pick, setPick] = useState("");
  const ix = useMemo(() => (doc ? treeIndexOf(doc) : null), [doc]);
  const serial = useMemo(() => (doc ? serialNosOf(doc) : null), [doc]);
  const task = ix?.byId.get(idKey(taskId));
  const deps = task?.dependencies;
  // Candidate list: per document / task (not per keystroke).
  const candidates = useMemo(() => {
    if (!doc || !ix || !task) return [];
    const excluded = new Set(
      [taskId, ...getAncestors(ix, taskId), ...getDescendants(ix, taskId), ...(deps ?? []).map((d) => d.predecessorId)].map(idKey),
    );
    return derivedOf(doc).order.filter((o) => !excluded.has(idKey(o)) && ix.byId.get(idKey(o))?.kind !== "category" && ix.byId.get(idKey(o))?.kind !== "milestone");
  }, [doc, ix, task, taskId, deps]);
  if (!doc || !ix || !serial || !task) return null;
  const rowNo = (id: string) => serial.get(idKey(id)) ?? 0;
  const nameOf = (id: string) => ix.byId.get(idKey(id))?.name ?? "";
  const depList = deps ?? [];
  const selected = candidates.some((c) => idKey(c) === idKey(pick)) ? pick : "";

  const add = () => {
    if (selected === "") return;
    const res = runCommand({
      type: "addDependency",
      succId: taskId,
      predId: selected,
    });
    if (res.ok) {
      setPick("");
    }
  };

  return (
    <fieldset className="field predecessors">
      <legend>{t("panel.predecessors")}</legend>
      {depList.length === 0 && <small className="note">{t("panel.noPredecessors")}</small>}
      <ul className="pred-list">
        {depList.map((d) => (
          <li key={d.predecessorId}>
            <span className="pred-label">
              {t("panel.predecessorOption", { no: rowNo(d.predecessorId), name: nameOf(d.predecessorId) })}
            </span>
            <button
              type="button"
              className="icon-btn"
              title={t("panel.remove")}
              aria-label={t("panel.remove")}
              onClick={() => runCommand({ type: "removeDependency", succId: taskId, predId: d.predecessorId })}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="pred-add">
        <select value={selected} data-testid="pred-select" onChange={(e) => setPick(e.target.value)}>
          <option value="">{t("panel.selectTask")}</option>
          {candidates.map((c) => (
            <option key={c} value={c}>
              {t("panel.predecessorOption", { no: rowNo(c), name: nameOf(c) })}
            </option>
          ))}
        </select>
        <button type="button" disabled={selected === ""} data-testid="pred-add" onClick={add}>
          {t("panel.addPredecessor")}
        </button>
      </div>
    </fieldset>
  );
}
