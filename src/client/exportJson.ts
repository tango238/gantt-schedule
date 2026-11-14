import { prepareForSave } from "../shared/engine";
import type { GanttDocument } from "../shared/model/types";

/** schema/gantt.schema.json の properties の並び (テストでスキーマと一致を確認する)。 */
export const KEY_ORDER = {
  root: ["$schema", "version", "project", "resources", "colorLabels", "tasks", "view"],
  project: ["name", "description", "calendar"],
  calendar: ["weekends", "holidays"],
  resource: ["id", "name", "color"],
  colorLabel: ["id", "name", "color"],
  task: ["id", "kind", "parentId", "name", "start", "end", "progress", "status", "hours", "resourceIds", "assigneeIds", "colorLabelId", "dependencies", "notes"],
  dependency: ["predecessorId"],
  view: ["zoom", "collapsedTaskIds"],
} as const;

function ordered(obj: Record<string, unknown> | undefined, order: readonly string[]): Record<string, unknown> | undefined {
  if (!obj) return obj;
  const out: Record<string, unknown> = {};
  for (const k of order) if (k in obj && obj[k] !== undefined) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!(k in out) && obj[k] !== undefined) out[k] = obj[k]; // 未知のフィールドは末尾に保持
  return out;
}

const each = <T,>(list: T[] | undefined, f: (x: T) => unknown) => list?.map(f);

/** スキーマの並びでキーを整えた書き出し用オブジェクト。 */
export function orderDocument(doc: GanttDocument): Record<string, unknown> {
  const d = doc as unknown as Record<string, unknown> & GanttDocument;
  const root = ordered(d, KEY_ORDER.root)!;
  const project = ordered(d.project as unknown as Record<string, unknown>, KEY_ORDER.project)!;
  if (d.project.calendar) project.calendar = ordered(d.project.calendar as unknown as Record<string, unknown>, KEY_ORDER.calendar);
  root.project = project;
  if (d.resources) root.resources = each(d.resources, (r) => ordered(r as unknown as Record<string, unknown>, KEY_ORDER.resource));
  if (d.colorLabels) root.colorLabels = each(d.colorLabels, (c) => ordered(c as unknown as Record<string, unknown>, KEY_ORDER.colorLabel));
  root.tasks = each(d.tasks, (t) => {
    const o = ordered(t as unknown as Record<string, unknown>, KEY_ORDER.task)!;
    if (t.dependencies) o.dependencies = each(t.dependencies, (x) => ordered(x as unknown as Record<string, unknown>, KEY_ORDER.dependency));
    return o;
  });
  if (d.view) root.view = ordered(d.view as unknown as Record<string, unknown>, KEY_ORDER.view);
  return root;
}

/** JSON エクスポートの本文: prepareForSave 相当の正規化 + スキーマ順のキー + インデント 2。 */
export function exportJsonText(doc: GanttDocument): string {
  return JSON.stringify(orderDocument(prepareForSave(doc)), null, 2) + "\n";
}

/** ダウンロード用ファイル名 (ファイル名に使えない文字を除く)。 */
export function exportFileName(name: string, suffix?: string): string {
  const base = (suffix ? `${name} (${suffix})` : name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 100);
  return `${base || "schedule"}.json`;
}

/** suffix: バージョン表示中にそのバージョンの内容を書き出すとき、ファイル名に付ける版名。 */
export function downloadJson(doc: GanttDocument, suffix?: string): void {
  const blob = new Blob([exportJsonText(doc)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFileName(doc.project.name, suffix);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
