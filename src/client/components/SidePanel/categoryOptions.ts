import { buildTreeIndex, displayOrder, getAncestors, isCategoryTask, nearestCategory } from "../../../shared/engine";
import { idKey } from "../../../shared/model/id";
import type { GanttDocument } from "../../../shared/model/types";

export interface CategoryOption {
  id: string;
  /** 入れ子のカテゴリは「親 / 子」のパス。 */
  label: string;
}

/** 全カテゴリ (表示順)。 */
export function categoryOptions(doc: GanttDocument): CategoryOption[] {
  const ix = buildTreeIndex(doc);
  const out: CategoryOption[] = [];
  for (const id of displayOrder(ix)) {
    const t = ix.byId.get(idKey(id))!;
    if (!isCategoryTask(t)) continue;
    const path = [...getAncestors(ix, id)].reverse().map((a) => ix.byId.get(idKey(a))!.name);
    out.push({ id: t.id, label: [...path, t.name].join(" / ") });
  }
  return out;
}

export interface TaskCategoryInfo {
  /** 変更できるのは、親がタスクではない (トップレベル / カテゴリ直下の) タスクだけ。 */
  editable: boolean;
  /** 現在のカテゴリ (祖先のうち最も近いもの)。null = カテゴリなし。 */
  categoryId: string | null;
  label: string | null;
}

export function taskCategoryInfo(doc: GanttDocument, taskId: string): TaskCategoryInfo {
  const ix = buildTreeIndex(doc);
  const t = ix.byId.get(idKey(taskId));
  const parent = t?.parentId ?? null;
  const editable = parent === null || isCategoryTask(ix.byId.get(idKey(parent)));
  const categoryId = nearestCategory(ix, taskId);
  const label = categoryId === null ? null : (categoryOptions(doc).find((o) => idKey(o.id) === idKey(categoryId))?.label ?? null);
  return { editable, categoryId, label };
}
