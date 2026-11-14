import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "../../shared/engine";
import type { GanttDocument } from "../../shared/model/types";
import { applyCommandToDoc, buildContext } from "./apply";
import { MAX_DOC_BYTES, checkSchema, stripView, utf8Length, validateImportedDoc } from "./validate";
import { generate } from "../../../scripts/gen-validator.mjs";

const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const sample = load("../../../schema/examples/sample.json") as GanttDocument;
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

const empty = (): GanttDocument => stripView(createEmptyDocument({ projectName: "テスト" })) as GanttDocument;
const clone = <T>(v: T): T => structuredClone(v);

describe("生成済み検証関数", () => {
  it("scripts/gen-validator.mjs の出力と一致している (スキーマ変更後は pnpm gen:validator)", () => {
    const current = readFileSync(new URL("./schemaValidator.generated.js", import.meta.url), "utf8");
    expect(current).toBe(generate());
  });
});

describe("validateImportedDoc", () => {
  it("sample.json を受理し view を落とす", () => {
    const r = validateImportedDoc(sample);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect("view" in r.doc).toBe(false);
      expect(r.doc.tasks.length).toBe(sample.tasks.length);
    }
  });
  it.each([null, 1, "x", [], undefined])("オブジェクト以外 (%j) は schema エラー", (v) => {
    const r = validateImportedDoc(v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("schema");
  });
  it("スキーマ違反: version 2", () => {
    const d = clone(sample) as unknown as { version: number };
    d.version = 2;
    const r = validateImportedDoc(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("schema");
  });
  it("スキーマ違反: 存在しない暦日 (format: date)", () => {
    const d = clone(sample);
    const leaf = d.tasks.find((t) => t.start !== undefined)!;
    leaf.start = "2023-02-31";
    const r = validateImportedDoc(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("schema");
  });
  it("スキーマ違反: 必須フィールド欠落", () => {
    const d = clone(sample) as unknown as Record<string, unknown>;
    delete d.tasks;
    expect(validateImportedDoc(d).ok).toBe(false);
  });
  it("整合性エラー: 存在しない親", () => {
    const d = clone(sample);
    d.tasks[1]!.parentId = "00000000-0000-4000-8000-000000000000";
    const r = validateImportedDoc(d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("integrity");
      expect(r.issues.some((i) => i.code === "PARENT_NOT_FOUND")).toBe(true);
    }
  });
  it("整合性エラー: ID 重複", () => {
    const d = clone(sample);
    d.tasks[1]!.id = d.tasks[0]!.id;
    const r = validateImportedDoc(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.code === "DUPLICATE_ID")).toBe(true);
  });
});

describe("applyCommandToDoc", () => {
  it("成功: addTask でタスクが増え、view は含まれず、JSON が返る", () => {
    const r = applyCommandToDoc(empty(), { type: "addTask", afterId: null }, undefined, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    expect(r.doc.tasks).toHaveLength(1);
    expect("view" in r.doc).toBe(false);
    expect(JSON.parse(r.json)).toEqual(r.doc);
  });
  it("クライアントの ids / today / defaultTaskName を採用する", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const r = applyCommandToDoc(
      empty(),
      { type: "addTask", afterId: null },
      { ids: [id], today: "2026-11-12", defaultTaskName: "Task X" },
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.tasks[0]!.id).toBe(id);
      expect(r.doc.tasks[0]!.name).toBe("Task X");
      expect(r.doc.tasks[0]!.start).toBe("2026-11-12");
    }
  });
  it("範囲外の today・不正な ids は無視してサーバー値を使う", () => {
    const ctx = buildContext(empty(), { today: "2030-01-01", ids: ["not-a-uuid", 5], defaultTaskName: 3 }, NOW);
    expect(ctx.today).toBe("2026-11-11");
    expect(ctx.newId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.defaultTaskName).toBe("新しいタスク");
  });
  it("既存 ID と衝突する ids は採用しない", () => {
    const base = applyCommandToDoc(empty(), { type: "addTask", afterId: null }, undefined, NOW);
    if (!base.ok) throw new Error("setup");
    const existing = base.doc.tasks[0]!.id;
    const r = applyCommandToDoc(base.doc, { type: "addTask", afterId: existing }, { ids: [existing] }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(new Set(r.doc.tasks.map((t) => t.id)).size).toBe(2);
  });
  it("setProjectInfo で name が project.name に追従する", () => {
    const r = applyCommandToDoc(empty(), { type: "setProjectInfo", name: "改名後" }, undefined, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe("改名後");
  });
  it("変更なしのコマンドは changed=false", () => {
    const r = applyCommandToDoc(empty(), { type: "rescheduleAll" }, undefined, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(false);
  });
  it("engine エラーは 422 command_rejected (コード付き)", () => {
    const r = applyCommandToDoc(empty(), { type: "indent", id: "nope" }, undefined, NOW);
    expect(r).toMatchObject({ ok: false, status: 422, error: "command_rejected", code: "TASK_NOT_FOUND" });
  });
  it.each([null, 5, [], {}, { type: "nope" }, { type: "__proto__" }, { type: "toString" }])("形が不正 (%j) は 400", (c) => {
    const r = applyCommandToDoc(empty(), c, undefined, NOW);
    expect(r).toMatchObject({ ok: false, status: 400, error: "invalid_command" });
  });
  it("フィールドの型が壊れていて engine が例外を投げても 500 にならない", () => {
    const r = applyCommandToDoc(empty(), { type: "addResource", name: { x: 1 } }, undefined, NOW);
    expect(r.ok === false && (r.status === 400 || r.status === 422)).toBe(true);
  });
  it("保存サイズが 1MB (UTF-8 バイト) を超えると 413", () => {
    // 全角 1 文字 = 3 バイト。文字数では 1MB 未満でもバイト数で超過する。
    const doc = empty();
    doc.project.description = "あ".repeat(Math.ceil(MAX_DOC_BYTES / 3) + 10);
    expect(doc.project.description.length).toBeLessThan(MAX_DOC_BYTES);
    const r = applyCommandToDoc(doc, { type: "addTask", afterId: null }, undefined, NOW);
    expect(r).toMatchObject({ ok: false, status: 413, error: "too_large", limit: MAX_DOC_BYTES });
    expect(utf8Length("あ")).toBe(3);
  });
  it("ちょうど 1MB は受理され、1 バイト超過は 413", () => {
    const base = utf8Length(JSON.stringify(applyOk(empty())));
    const key = utf8Length(',"description":""');
    const withDesc = (len: number) => {
      const doc = empty();
      doc.project.description = "a".repeat(len);
      return applyCommandToDoc(doc, { type: "addTask", afterId: null }, { ids: ["11111111-2222-4333-8444-555555555555"] }, NOW);
    };
    // 追加されるタスクの id / start が基準 (applyOk) と同じ長さになるよう、today / name は同条件。
    const len = MAX_DOC_BYTES - base - key;
    const r = withDesc(len);
    expect(r.ok).toBe(true);
    if (r.ok) expect(utf8Length(r.json)).toBe(MAX_DOC_BYTES);
    expect(withDesc(len + 1)).toMatchObject({ ok: false, status: 413 });
  });
  it("replaceDocument は doc を検証する (不正なら 422、view は落ちる)", () => {
    const bad = applyCommandToDoc(empty(), { type: "replaceDocument", doc: { version: 2 } }, undefined, NOW);
    expect(bad).toMatchObject({ ok: false, status: 422, error: "invalid_document", kind: "schema" });
    const ok = applyCommandToDoc(empty(), { type: "replaceDocument", doc: sample }, undefined, NOW);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect("view" in ok.doc).toBe(false);
      expect(ok.doc.tasks.length).toBe(sample.tasks.length);
    }
  });
  it("入力 doc を破壊しない", () => {
    const doc = empty();
    const before = JSON.stringify(doc);
    applyCommandToDoc(doc, { type: "addTask", afterId: null }, undefined, NOW);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

function applyOk(doc: GanttDocument): GanttDocument {
  const r = applyCommandToDoc(doc, { type: "addTask", afterId: null }, undefined, NOW);
  if (!r.ok) throw new Error("setup");
  return r.doc;
}

describe("壊れた doc を保存しない (D1)", () => {
  const twoTasks = (): GanttDocument => {
    let doc = empty();
    for (let i = 0; i < 2; i++) {
      const r = applyCommandToDoc(doc, { type: "addTask", afterId: null }, undefined, NOW);
      if (!r.ok) throw new Error("setup");
      doc = r.doc;
    }
    return doc;
  };
  it("巨大 deltaDays は 422 (INVALID_VALUE)", () => {
    const doc = twoTasks();
    const r = applyCommandToDoc(doc, { type: "moveTask", id: doc.tasks[0]!.id, deltaDays: 100000000 }, undefined, NOW);
    expect(r).toMatchObject({ ok: false, status: 422, error: "command_rejected", code: "INVALID_VALUE" });
  });
  it("配列の color は 422", () => {
    const r = applyCommandToDoc(empty(), { type: "addColorLabel", name: "x", color: ["#ffffff"] }, undefined, NOW);
    expect(r).toMatchObject({ ok: false, status: 422, code: "INVALID_VALUE" });
  });
  it("setCalendar: 未知キーはスキーマで弾かれない (additionalProperties 許可) が、不正な型は弾かれる", () => {
    const ok = applyCommandToDoc(
      empty(),
      { type: "setCalendar", calendar: { weekends: [0, 6], holidays: [], extra: 1 } },
      undefined,
      NOW,
    );
    // 仕様固定: スキーマは未知フィールドを許可する (保持される)
    expect(ok.ok).toBe(true);
    const bad = applyCommandToDoc(empty(), { type: "setCalendar", calendar: { weekends: [9], holidays: [] } }, undefined, NOW);
    expect(bad.ok).toBe(false);
  });
  it("最終検査: engine を通っても (擬似的に) スキーマ違反なら 422 invalid_document", () => {
    // project.name 空は engine が拒否するが、保存側でも同じ検査が掛かる
    const r = applyCommandToDoc(empty(), { type: "setProjectInfo", name: "   " }, undefined, NOW);
    expect(r).toMatchObject({ ok: false, status: 422 });
  });
  it("project.name は 1〜200 文字 (setProjectInfo とインポート)", () => {
    expect(applyCommandToDoc(empty(), { type: "setProjectInfo", name: "a".repeat(200) }, undefined, NOW).ok).toBe(true);
    expect(applyCommandToDoc(empty(), { type: "setProjectInfo", name: "a".repeat(201) }, undefined, NOW).ok).toBe(false);
    expect(applyCommandToDoc(empty(), { type: "setProjectInfo", name: "x".repeat(500000) }, undefined, NOW).ok).toBe(false);
    const d = clone(sample);
    d.project.name = "";
    expect(validateImportedDoc(d).ok).toBe(false);
    d.project.name = "あ".repeat(201);
    expect(validateImportedDoc(d).ok).toBe(false);
    d.project.name = "あ".repeat(200);
    expect(validateImportedDoc(d).ok).toBe(true);
  });
  it("インポートの warnings を返す", () => {
    const d = clone(sample);
    d.tasks.find((t) => t.start !== undefined)!.resourceIds = ["00000000-0000-4000-8000-000000000009"];
    const r = validateImportedDoc(d);
    expect(r.ok && r.warnings.some((w) => w.code === "UNKNOWN_RESOURCE")).toBe(true);
  });
});

describe("カテゴリ", () => {
  const withCategory = (): GanttDocument => {
    const d = empty();
    d.tasks = [
      { id: "11111111-1111-4111-8111-111111111111", kind: "category", parentId: null, name: "C", resourceIds: [], dependencies: [] },
      {
        id: "22222222-2222-4222-8222-222222222222",
        parentId: "11111111-1111-4111-8111-111111111111",
        name: "T",
        start: "2026-11-12",
        end: "2026-11-12",
        progress: 0,
        resourceIds: [],
        dependencies: [],
      },
    ];
    return d;
  };

  it("kind を持つ doc をインポートでき、カテゴリは保たれる", () => {
    const r = validateImportedDoc(withCategory());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.tasks[0]!.kind).toBe("category");
      expect(r.doc.tasks[0]!.start).toBeUndefined();
    }
  });
  it("kind の値が不正ならスキーマエラー", () => {
    const d = withCategory() as unknown as { tasks: Array<{ kind: string }> };
    d.tasks[0]!.kind = "folder";
    const r = validateImportedDoc(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("schema");
  });
  it("日付を持つカテゴリ・タスクの下のカテゴリ・カテゴリへの依存は整合性エラー", () => {
    const a = withCategory();
    a.tasks[0]!.start = "2026-11-12";
    const ra = validateImportedDoc(a);
    expect(ra.ok).toBe(false);
    if (!ra.ok) expect(ra.issues).toContainEqual({ code: "CATEGORY_FIELD", path: "/tasks/0/start", params: { field: "start" } });

    const b = withCategory();
    b.tasks.push({ id: "33333333-3333-4333-8333-333333333333", kind: "category", parentId: "22222222-2222-4222-8222-222222222222", name: "X", resourceIds: [], dependencies: [] });
    const rb = validateImportedDoc(b);
    expect(rb.ok).toBe(false);
    if (!rb.ok) expect(rb.issues.map((i) => i.code)).toContain("CATEGORY_PARENT");

    const c = withCategory();
    c.tasks[1]!.dependencies = [{ predecessorId: "11111111-1111-4111-8111-111111111111" }];
    const rc = validateImportedDoc(c);
    expect(rc.ok).toBe(false);
    if (!rc.ok) expect(rc.issues.map((i) => i.code)).toContain("CATEGORY_DEPENDENCY");
  });
  it("addCategory: クライアントの ids / defaultCategoryName を採用し、無ければ既定名", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const r = applyCommandToDoc(empty(), { type: "addCategory", afterId: null }, { ids: [id], today: "2026-11-12", defaultCategoryName: "Cat X" }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.tasks[0]).toMatchObject({ id, kind: "category", name: "Cat X" });
    expect(buildContext(empty(), { defaultCategoryName: 3 }, NOW).defaultCategoryName).toBe("新しいカテゴリ");
    const d = applyCommandToDoc(empty(), { type: "addCategory", afterId: null }, undefined, NOW);
    expect(d.ok && d.doc.tasks[0]!.name).toBe("新しいカテゴリ");
  });
  it("コマンドの結果が保存用のスキーマ検査を通る (addCategory 後の addTask は日付を持ち、カテゴリは持たない)", () => {
    const r1 = applyCommandToDoc(empty(), { type: "addCategory", afterId: null }, undefined, NOW);
    if (!r1.ok) throw new Error("setup");
    expect(checkSchema(r1.doc)).toEqual([]);
    const r2 = applyCommandToDoc(r1.doc, { type: "setDates", id: r1.doc.tasks[0]!.id, start: "2026-11-12", end: "2026-11-12" }, undefined, NOW);
    expect(r2.ok).toBe(false);
    if (!r2.ok && r2.error === "command_rejected") expect(r2.code).toBe("CATEGORY_NOT_EDITABLE");
  });
});

describe("担当 (assigneeIds) とカテゴリ順の検証", () => {
  const leaf = (id: string, extra: Record<string, unknown> = {}) => ({ id, parentId: null, name: id, start: "2026-11-12", end: "2026-11-12", progress: 0, resourceIds: [], dependencies: [], ...extra });
  const U = "11111111-1111-4111-8111-11111111111";
  const mk = (tasks: unknown[]) => ({ ...clone(sample), tasks, resources: [], colorLabels: [] }) as unknown as GanttDocument;

  it("未知のユーザー ID もそのまま受理して保持する", () => {
    const r = validateImportedDoc(mk([leaf(U + "1", { assigneeIds: ["gone-user", "Another_ID-1"] })]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.tasks[0]!.assigneeIds).toEqual(["gone-user", "Another_ID-1"]);
  });
  it("21 人・重複・空文字・非文字列はスキーマ違反", () => {
    const ids = Array.from({ length: 21 }, (_, i) => "u" + i);
    for (const bad of [ids, ["a", "a"], [""], [1], "a", ["x".repeat(65)]]) {
      const r = validateImportedDoc(mk([leaf(U + "1", { assigneeIds: bad })]));
      expect(r.ok, JSON.stringify(bad).slice(0, 40)).toBe(false);
      if (!r.ok) expect(r.kind).toBe("schema");
    }
    expect(validateImportedDoc(mk([leaf(U + "1", { assigneeIds: ids.slice(0, 20) })])).ok).toBe(true);
  });
  it("カテゴリに担当者があると整合性エラー", () => {
    const cat = { id: U + "2", kind: "category", parentId: null, name: "c", resourceIds: [], dependencies: [], assigneeIds: ["u"] };
    const r = validateImportedDoc(mk([cat]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("integrity");
      expect(r.issues[0]).toMatchObject({ code: "CATEGORY_FIELD" });
    }
  });
  it("setAssignees コマンドを適用でき、カテゴリには 422", () => {
    const cat = { id: U + "2", kind: "category", parentId: null, name: "c", resourceIds: [], dependencies: [] };
    const doc = mk([cat, leaf(U + "1")]);
    const ok = applyCommandToDoc(doc, { type: "setAssignees", id: U + "1", userIds: ["a", "b"] }, undefined, NOW);
    expect(ok.ok && ok.doc.tasks.find((t) => t.id === U + "1")!.assigneeIds).toEqual(["a", "b"]);
    expect(applyCommandToDoc(doc, { type: "setAssignees", id: U + "2", userIds: ["a"] }, undefined, NOW)).toMatchObject({ ok: false, status: 422, code: "CATEGORY_NOT_EDITABLE" });
  });
  it("インポートと replaceDocument はトップレベルを「カテゴリ → カテゴリなしタスク」に並べ替える", () => {
    const cat = { id: U + "2", kind: "category", parentId: null, name: "c", resourceIds: [], dependencies: [] };
    const raw = mk([leaf(U + "1"), cat]);
    const imp = validateImportedDoc(raw);
    expect(imp.ok && imp.doc.tasks.map((t) => t.id)).toEqual([U + "2", U + "1"]);
    const rep = applyCommandToDoc(empty(), { type: "replaceDocument", doc: raw }, undefined, NOW);
    expect(rep.ok && rep.doc.tasks.map((t) => t.id)).toEqual([U + "2", U + "1"]);
  });
  it("setCategory コマンドを適用できる", () => {
    const cat = { id: U + "2", kind: "category", parentId: null, name: "c", resourceIds: [], dependencies: [] };
    const r = applyCommandToDoc(mk([cat, leaf(U + "1")]), { type: "setCategory", id: U + "1", categoryId: U + "2" }, undefined, NOW);
    expect(r.ok && r.doc.tasks.find((t) => t.id === U + "1")!.parentId).toBe(U + "2");
  });
});

describe("マイルストーン・状態・進捗廃止の検証", () => {
  const U = "11111111-1111-4111-8111-11111111111";
  const leaf = (id: string, extra: Record<string, unknown> = {}) => ({ id, parentId: null, name: id, start: "2026-11-12", end: "2026-11-12", resourceIds: [], dependencies: [], ...extra });
  const mile = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "milestone", parentId: null, name: id, start: "2026-11-14", end: "2026-11-14", resourceIds: [], dependencies: [], ...extra });
  const mk = (tasks: unknown[]) => ({ ...clone(sample), tasks, resources: [], colorLabels: [] }) as unknown as GanttDocument;

  it("正しいマイルストーン (稼働日でない日・カテゴリの下) と status は受理する", () => {
    const cat = { id: U + "3", kind: "category", parentId: null, name: "c", resourceIds: [], dependencies: [] };
    const r = validateImportedDoc(mk([cat, mile(U + "2", { parentId: U + "3" }), leaf(U + "1", { status: "doing" })]));
    expect(r.ok).toBe(true);
  });
  it.each<[string, Record<string, unknown>, string]>([
    ["status", { status: "done" }, "MILESTONE_FIELD"],
    ["hours", { hours: 3 }, "MILESTONE_FIELD"],
    ["担当", { assigneeIds: ["u"] }, "MILESTONE_FIELD"],
    ["リソース", { resourceIds: [U + "9"] }, "MILESTONE_FIELD"],
    ["依存", { dependencies: [{ predecessorId: U + "1" }] }, "MILESTONE_FIELD"],
    ["期間", { end: "2026-11-20" }, "MILESTONE_DATE"],
  ])("不正なマイルストーン (%s) は整合性エラー", (_n, extra, code) => {
    const r = validateImportedDoc(mk([leaf(U + "1"), mile(U + "2", extra)]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("integrity");
      expect(r.issues.map((i) => i.code)).toContain(code);
    }
  });
  it("タスクの下・子を持つマイルストーン、マイルストーンへの依存は整合性エラー", () => {
    const parent = validateImportedDoc(mk([leaf(U + "1"), mile(U + "2", { parentId: U + "1" })]));
    expect(parent.ok === false && parent.issues.map((i) => i.code)).toContain("MILESTONE_PARENT");
    const child = validateImportedDoc(mk([mile(U + "2"), leaf(U + "1", { parentId: U + "2" })]));
    expect(child.ok === false && child.issues.map((i) => i.code)).toContain("MILESTONE_CHILD");
    const dep = validateImportedDoc(mk([mile(U + "2"), leaf(U + "1", { dependencies: [{ predecessorId: U + "2" }] })]));
    expect(dep.ok === false && dep.issues.map((i) => i.code)).toContain("MILESTONE_DEPENDENCY");
  });
  it("status の値がスキーマ外なら schema エラー", () => {
    const r = validateImportedDoc(mk([leaf(U + "1", { status: "finished" })]));
    expect(r.ok === false && r.kind).toBe("schema");
  });
  it("進捗 (progress) 付きの古い doc は受理し、値は保持される。progress なしも受理", () => {
    const r = validateImportedDoc(mk([leaf(U + "1", { progress: 40 }), leaf(U + "2")]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.tasks[0]!.progress).toBe(40);
    expect(validateImportedDoc(clone(sample)).ok).toBe(true); // 進捗入りの sample
  });
  it("コマンド: setStatus / addMilestone は適用でき、setProgress は未知のコマンドとして 400", () => {
    const doc = mk([leaf(U + "1")]);
    const a = applyCommandToDoc(doc, { type: "setStatus", id: U + "1", status: "done" }, undefined, NOW);
    expect(a.ok && a.doc.tasks[0]!.status).toBe("done");
    const m = applyCommandToDoc(doc, { type: "addMilestone", afterId: null }, { ids: ["22222222-2222-4222-8222-222222222222"], defaultMilestoneName: "MS", today: "2026-11-12" }, NOW);
    expect(m.ok && m.doc.tasks.find((t) => t.kind === "milestone")).toMatchObject({ name: "MS", start: "2026-11-12", end: "2026-11-12" });
    expect(applyCommandToDoc(doc, { type: "setProgress", id: U + "1", progress: 50 }, undefined, NOW)).toMatchObject({ ok: false, status: 400, error: "invalid_command" });
  });
});
