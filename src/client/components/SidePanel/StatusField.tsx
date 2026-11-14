import { overdueReasons, statusOf } from "../../../shared/engine";
import type { IsoDate, Task, TaskStatus } from "../../../shared/model/types";
import { t } from "../../i18n";
import { runCommand } from "../actions";

const STATUSES: readonly TaskStatus[] = ["todo", "doing", "done"];

/** 状態の選択 (未着手 / 進行中 / 完了)。期限超過は、当てはまる理由をすべて出す (閲覧者のローカルの今日で導出)。 */
export function StatusField({ task, start, end, today }: { task: Task; start: IsoDate; end: IsoDate; today: IsoDate }) {
  const status = statusOf(task);
  const reasons = overdueReasons(task.status, start, end, today);
  return (
    <div className="field status-field" data-testid="panel-status-field">
      <span>{t("panel.status")}</span>
      <div className="status-choices" role="radiogroup" aria-label={t("panel.status")}>
        {STATUSES.map((s) => (
          <label key={s} className={`status-choice${status === s ? " selected" : ""}`}>
            <input
              type="radio"
              name={`status-${task.id}`}
              checked={status === s}
              data-testid={`panel-status-${s}`}
              onChange={() => runCommand({ type: "setStatus", id: task.id, status: s })}
            />
            {t(`status.label.${s}`)}
          </label>
        ))}
      </div>
      {reasons.length > 0 && (
        <ul className="overdue-list" data-testid="panel-overdue" role="alert">
          {reasons.map((r) => (
            <li key={r}>{t(`status.overdueMessage.${r}`)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
