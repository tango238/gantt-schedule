import { formatDuration, getDerived, parseDuration } from "../../../shared/engine";
import { t } from "../../i18n";
import { idKey } from "../../../shared/model/id";
import { useAppStore } from "../../store/appStore";
import { calendarOf, derivedOf, displayDoc, treeIndexOf } from "../../store/selectors";
import { runCommand } from "../actions";
import { CommitInput } from "./fields";
import { PredecessorEditor } from "./PredecessorEditor";
import { StatusField } from "./StatusField";
import { useToday } from "../../useToday";
import { AssigneeField } from "./AssigneeField";
import { CategoryField } from "./CategoryField";
import { CommentsSection } from "./CommentsSection";

const HOURS_RE = /^\d+(\.\d+)?$/;
const DATE_RE = /^(\d{4})-\d{2}-\d{2}$/;
const validYear = (v: string): boolean => {
  const m = DATE_RE.exec(v);
  return m !== null && Number(m[1]) >= 1900 && Number(m[1]) <= 2999;
};

/** Task detail editor (03 section 9.1). */
export function TasksTab() {
  const doc = useAppStore(displayDoc);
  const selectedId = useAppStore((s) => s.selectedId);
  const today = useToday();
  if (!doc || selectedId === null) return <p className="panel-empty">{t("panel.noSelection")}</p>;
  const task = treeIndexOf(doc).byId.get(idKey(selectedId));
  const dt = getDerived(derivedOf(doc), selectedId);
  if (!task || !dt) return <p className="panel-empty">{t("panel.noSelection")}</p>;

  const wc = calendarOf(doc);
  const id = task.id;
  const notesField = (
    <label className="field">
      <span>{t("panel.notes")}</span>
      <CommitInput
        multiline
        rows={10}
        value={task.notes ?? ""}
        testId="panel-notes"
        commit={(v) => {
          return runCommand({ type: "setNotes", id, notes: v }).ok;
        }}
      />
    </label>
  );
  const colorField = (
    <fieldset className="field">
      <legend>{t("panel.colorLabel")}</legend>
      <div className="swatches">
        <button
          type="button"
          className={`swatch none${task.colorLabelId === undefined ? " selected" : ""}`}
          onClick={() => runCommand({ type: "setColorLabel", id, colorLabelId: null })}
        >
          {t("panel.colorLabelNone")}
        </button>
        {(doc.colorLabels ?? []).map((l) => (
          <button
            key={l.id}
            type="button"
            title={l.name}
            aria-label={l.name}
            className={`swatch${task.colorLabelId !== undefined && idKey(task.colorLabelId) === idKey(l.id) ? " selected" : ""}`}
            style={{ background: l.color }}
            onClick={() => runCommand({ type: "setColorLabel", id, colorLabelId: l.id })}
          />
        ))}
      </div>
    </fieldset>
  );
  const nameField = (
    <label className="field">
      <span>{t(dt.isCategory ? "panel.categoryName" : dt.isMilestone ? "panel.milestoneName" : "panel.name")}</span>
      <CommitInput
        value={task.name}
        testId="panel-name"
        commit={(v) => {
          if (v.trim() === "") return false;
          return runCommand({ type: "setName", id, name: v }).ok;
        }}
      />
    </label>
  );
  // カテゴリは名前・メモ・色ラベルだけ。
  if (dt.isCategory) {
    return (
      <div className="panel-form" key={id} data-testid="panel-category">
        {nameField}
        {colorField}
        {notesField}
        <CommentsSection taskId={id} />
      </div>
    );
  }
  // マイルストーン: 名前・日付 (1 つ)・カテゴリ・色ラベル・詳細・コメントだけ。
  if (dt.isMilestone) {
    const validDate = (v: string) => validYear(v);
    return (
      <div className="panel-form" key={id} data-testid="panel-milestone">
        {nameField}
        <label className="field">
          <span>{t("panel.milestoneDate")}</span>
          <CommitInput
            type="date"
            value={dt.start}
            testId="panel-milestone-date"
            commitOnChange={validDate}
            commit={(v) => validDate(v) && runCommand({ type: "setDates", id, start: v, end: v }).ok}
          />
        </label>
        <CategoryField doc={doc} taskId={id} />
        {colorField}
        {notesField}
        <CommentsSection taskId={id} />
      </div>
    );
  }
  const isParent = dt.isParent;
  const resources = doc.resources ?? [];
  const checked = new Set((task.resourceIds ?? []).map(idKey));

  return (
    <div className="panel-form" key={id}>
      {nameField}

      <CategoryField doc={doc} taskId={id} />

      {!isParent && <StatusField task={task} start={dt.start} end={dt.end} today={today} />}

      <label className="field">
        <span>{t("panel.hours")}</span>
        <CommitInput
          type="number"
          extra={{ min: 0, step: 0.5 }}
          value={dt.hours === undefined ? "" : String(dt.hours)}
          disabled={isParent}
          testId="panel-hours"
          commit={(v) => {
            const s = v.trim();
            if (s === "") return runCommand({ type: "setHours", id, hours: null }).ok;
            if (!HOURS_RE.test(s)) return false;
            return runCommand({ type: "setHours", id, hours: Number(s) }).ok;
          }}
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span>{t("panel.start")}</span>
          <CommitInput
            type="date"
            value={dt.start}
            disabled={isParent}
            testId="panel-start"
            commitOnChange={validYear}
            commit={(v) => validYear(v) && runCommand({ type: "setDates", id, start: v, end: dt.end }).ok}
          />
        </label>
        <label className="field">
          <span>{t("panel.end")}</span>
          <CommitInput
            type="date"
            value={dt.end}
            disabled={isParent}
            testId="panel-end"
            commitOnChange={validYear}
            commit={(v) => validYear(v) && runCommand({ type: "setDates", id, start: dt.start, end: v }).ok}
          />
        </label>
      </div>

      <label className="field">
        <span>{t("panel.duration")}</span>
        <CommitInput
          value={formatDuration(dt.durationDays, wc)}
          disabled={isParent}
          testId="panel-duration"
          commit={(v) => {
            const days = parseDuration(v, wc);
            if (days === null) return false;
            return runCommand({ type: "setDuration", id, days }).ok;
          }}
        />
      </label>

      <AssigneeField taskId={id} assigneeIds={task.assigneeIds ?? []} />

      <fieldset className="field">
        <legend>{t("panel.resources")}</legend>
        {resources.map((r) => (
          <label key={r.id} className="check">
            <input
              type="checkbox"
              checked={checked.has(idKey(r.id))}
              onChange={(e) => {
                const next = resources
                  .filter((x) => (idKey(x.id) === idKey(r.id) ? e.target.checked : checked.has(idKey(x.id))))
                  .map((x) => x.id);
                runCommand({ type: "setResources", id, resourceIds: next });
              }}
            />
            <span className="chip" style={{ background: r.color ?? "#9ca3af" }} />
            {r.name}
          </label>
        ))}
        {isParent && <small className="note">{t("panel.resourcesPropagate")}</small>}
      </fieldset>

      {colorField}

      <PredecessorEditor taskId={id} />

      {notesField}

      <CommentsSection taskId={id} />
    </div>
  );
}
