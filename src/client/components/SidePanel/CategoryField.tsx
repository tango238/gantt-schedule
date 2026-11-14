import { t } from "../../i18n";
import { idKey } from "../../../shared/model/id";
import type { GanttDocument } from "../../../shared/model/types";
import { runCommand } from "../actions";
import { categoryOptions, taskCategoryInfo } from "./categoryOptions";

/** タスクのカテゴリ (単一選択)。サブタスクは親タスクのカテゴリを読み取り専用で表示する。 */
export function CategoryField({ doc, taskId }: { doc: GanttDocument; taskId: string }) {
  const info = taskCategoryInfo(doc, taskId);
  if (!info.editable) {
    return (
      <div className="field" data-testid="panel-category-inherited">
        <span>{t("panel.category")}</span>
        <div className="readonly-value">{info.label ?? t("category.none")}</div>
        <small className="note">{t("panel.categoryInherited")}</small>
      </div>
    );
  }
  const options = categoryOptions(doc);
  return (
    <label className="field">
      <span>{t("panel.category")}</span>
      <select
        value={info.categoryId === null ? "" : (options.find((o) => idKey(o.id) === idKey(info.categoryId!))?.id ?? "")}
        data-testid="panel-category-select"
        onChange={(e) => runCommand({ type: "setCategory", id: taskId, categoryId: e.target.value === "" ? null : e.target.value })}
      >
        <option value="">{t("category.none")}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
