import { t } from "../../i18n";
import { useUsersStore } from "../../users/usersStore";
import { runCommand } from "../actions";
import { MAX_ASSIGNEES } from "../../../shared/engine";

/** 名前の頭文字を丸で表す (プロフィール画像は CSP のため使わない)。色は ID から決めた固定の 8 色のクラス。 */
export function Avatar({ name, id }: { name: string; id: string }) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const initial = Array.from(name.trim())[0] ?? "?";
  return (
    <span className={`avatar av${h % 8}`} aria-hidden="true">
      {initial}
    </span>
  );
}

/** 担当ユーザーの選択 (複数)。追加は一覧から選び、外すはチップの ×。 */
export function AssigneeField({ taskId, assigneeIds }: { taskId: string; assigneeIds: readonly string[] }) {
  const users = useUsersStore((s) => s.users);
  const set = (next: string[]) => runCommand({ type: "setAssignees", id: taskId, userIds: next });
  const byId = new Map((users ?? []).map((u) => [u.id, u]));
  const addable = (users ?? []).filter((u) => !assigneeIds.includes(u.id));
  const full = assigneeIds.length >= MAX_ASSIGNEES;
  return (
    <fieldset className="field assignee-field" data-testid="panel-assignees">
      <legend>{t("panel.assignees")}</legend>
      {assigneeIds.length > 0 && (
        <ul className="assignee-list">
          {assigneeIds.map((id) => {
            const u = byId.get(id);
            const name = users === null ? "…" : (u?.name ?? t("assignee.unknown"));
            return (
              <li key={id} className={`assignee-chip${users !== null && !u ? " unknown" : ""}`} data-testid="assignee-chip">
                <Avatar name={u?.name ?? "?"} id={id} />
                <span className="assignee-name" title={u?.email}>
                  {name}
                </span>
                <button
                  type="button"
                  className="assignee-remove"
                  aria-label={t("panel.assigneeRemove", { name })}
                  title={t("panel.assigneeRemove", { name })}
                  onClick={() => set(assigneeIds.filter((x) => x !== id))}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <select
        value=""
        aria-label={t("panel.assigneeAdd")}
        data-testid="assignee-add"
        disabled={full || users === null || addable.length === 0}
        onChange={(e) => {
          if (e.target.value !== "") set([...assigneeIds, e.target.value]);
        }}
      >
        <option value="">{full ? t("panel.assigneeFull", { max: MAX_ASSIGNEES }) : t("panel.assigneeAdd")}</option>
        {addable.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name} ({u.email})
          </option>
        ))}
      </select>
    </fieldset>
  );
}
