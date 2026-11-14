import { describe, expect, it } from "vitest";
import { doc, seq, task } from "../../../shared/engine/__tests__/fixtures";
import type { GanttDocument } from "../../../shared/model/types";
import { parseOps, type AiOp } from "../ops";
import { dryRun } from "../plan";
import { findCategoryIssues as findIssues } from "../../../shared/engine";

const base = (): GanttDocument => {
  const d = doc([
    task({ id: "A", name: "設計" }),
    task({ id: "A1", parentId: "A", start: "2023-05-22", end: "2023-05-23", name: "要件" }),
    task({ id: "A2", parentId: "A", start: "2023-05-24", end: "2023-05-25", name: "基本設計", deps: ["A1"] }),
    task({ id: "B", start: "2023-05-29", end: "2023-05-30", name: "実装" }),
  ]);
  d.resources = [{ id: "R1", name: "山田" }];
  d.colorLabels = [{ id: "C1", name: "重要", color: "#ff0000" }];
  return d;
};
const ctx = () => ({ today: "2023-05-22", newId: seq("N"), defaultTaskName: "新しいタスク", defaultCategoryName: "新しいカテゴリ" });
const parse = (raw: unknown): AiOp[] => {
  const r = parseOps(raw);
  if (!r.ok) throw new Error(r.error);
  return r.ops;
};

describe("parseOps", () => {
  it("accepts a valid list and strips undefined fields", () => {
    const ops = parse([{ op: "updateTask", id: "A1", name: "x" }]);
    expect(ops).toEqual([{ op: "updateTask", id: "A1", name: "x" }]);
  });
  it("rejects unknown ops, bad dates, bad temp ids, duplicates, empty updates", () => {
    expect(parseOps([{ op: "dropDatabase" }]).ok).toBe(false);
    expect(parseOps([{ op: "updateTask", id: "A1", start: "2023-02-30" }]).ok).toBe(false);
    expect(parseOps([{ op: "addTask", tempId: "x1", name: "a" }]).ok).toBe(false);
    expect(
      parseOps([
        { op: "addTask", tempId: "new:1", name: "a" },
        { op: "addTask", tempId: "new:1", name: "b" },
      ]).ok,
    ).toBe(false);
    expect(parseOps([{ op: "updateTask", id: "A1" }]).ok).toBe(false);
    expect(parseOps({}).ok).toBe(false);
    expect(parseOps([{ op: "addResource", tempId: "new:1", name: "a", color: "red" }]).ok).toBe(false);
    expect(parseOps([{ op: "shiftTask", id: "A1", deltaDays: 1.5 }]).ok).toBe(false);
    expect(parseOps(Array.from({ length: 201 }, () => ({ op: "deleteTask", id: "A1" }))).ok).toBe(false);
  });
  it("reports the index of the bad operation", () => {
    const r = parseOps([{ op: "deleteTask", id: "A1" }, { op: "deleteTask" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("#2");
  });
});

describe("dryRun: translation with temp ids", () => {
  it("adds a task under a parent and references it from later ops", () => {
    const ops = parse([
      { op: "addResource", tempId: "new:r", name: "佐藤", color: "#00ff00" },
      { op: "addTask", tempId: "new:1", name: "レビュー", start: "2023-05-26", end: "2023-05-26", parentId: "A", resourceIds: ["new:r"] },
      { op: "addTask", tempId: "new:2", name: "修正", start: "2023-05-30", end: "2023-05-31", afterId: "new:1", parentId: "A", dependsOn: [{ id: "new:1" }] },
      { op: "updateTask", id: "B", name: "実装 (改)" },
    ]);
    const r = dryRun(base(), ops, { ctx: ctx() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = r.after.tasks.map((t) => t.name);
    expect(names).toEqual(["設計", "要件", "基本設計", "レビュー", "修正", "実装 (改)"]);
    const review = r.after.tasks.find((t) => t.name === "レビュー")!;
    const fix = r.after.tasks.find((t) => t.name === "修正")!;
    expect(review.parentId).toBe("A");
    expect(fix.parentId).toBe("A");
    expect(fix.dependencies?.[0]?.predecessorId).toBe(review.id);
    expect(review.resourceIds).toEqual([r.after.resources!.find((x) => x.name === "佐藤")!.id]);
    expect(r.diff.added.map((a) => a.name)).toEqual(["レビュー", "修正"]);
    expect(r.diff.resources[0]).toMatchObject({ kind: "added", name: "佐藤" });
    expect(r.diff.dependencies).toHaveLength(1);
  });

  it("adds a child to a leaf (indent) and a root task at the end", () => {
    const ops = parse([
      { op: "addTask", tempId: "new:1", name: "子", start: "2023-06-01", end: "2023-06-01", parentId: "B" },
      { op: "addTask", tempId: "new:2", name: "最後", start: "2023-06-05", end: "2023-06-05" },
    ]);
    const r = dryRun(base(), ops, { ctx: ctx() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.after.tasks.find((t) => t.name === "子")!.parentId).toBe("B");
    expect(r.after.tasks[r.after.tasks.length - 1]!.name).toBe("最後");
    expect(r.after.tasks[r.after.tasks.length - 1]!.parentId).toBeNull();
  });

  it("rejects afterId that is not a direct child of parentId", () => {
    const ops = parse([{ op: "addTask", tempId: "new:1", name: "x", parentId: "A", afterId: "B" }]);
    const r = dryRun(base(), ops, { ctx: ctx() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("UNRESOLVED");
  });

  it("fails on unknown ids and on temp ids used before definition", () => {
    const a = dryRun(base(), parse([{ op: "deleteTask", id: "ZZZ" }]), { ctx: ctx() });
    expect(a.ok).toBe(false);
    const b = dryRun(base(), parse([{ op: "updateTask", id: "new:1", name: "x" }, { op: "addTask", tempId: "new:1", name: "y" }]), { ctx: ctx() });
    expect(b.ok).toBe(false);
  });

  it("surfaces engine rejections with the failing operation", () => {
    const r = dryRun(base(), parse([{ op: "updateTask", id: "A1", name: "ok" }, { op: "updateTask", id: "A", start: "2023-06-01", end: "2023-06-02" }]), { ctx: ctx() });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.index).toBe(1);
    expect(r.failure.code).toBe("PARENT_NOT_EDITABLE");
    expect(r.run.doneOps).toBe(1);
  });

  it("rejects a dependency cycle", () => {
    const r = dryRun(base(), parse([{ op: "addDependency", taskId: "A1", predecessorId: "A2" }]), { ctx: ctx() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("DEPENDENCY_CYCLE");
  });

  it("does not mutate the input document", () => {
    const d = base();
    const snap = JSON.stringify(d);
    dryRun(d, parse([{ op: "deleteTask", id: "B" }]), { ctx: ctx() });
    expect(JSON.stringify(d)).toBe(snap);
  });
});

describe("dryRun: diff", () => {
  it("shows linked reschedules, deletions, calendar and project changes", () => {
    const r = dryRun(
      base(),
      parse([
        { op: "shiftTask", id: "A1", deltaDays: 7 }, // A2 depends on A1 so it is pushed too
        { op: "deleteTask", id: "B" },
        { op: "setCalendar", weekends: [0, 6], holidays: ["2023-06-05"] },
        { op: "setProjectInfo", name: "新名称" },
      ]),
      { ctx: ctx() },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a1 = r.diff.changed.find((c) => c.name === "要件")!;
    expect(a1.changes.map((c) => c.label)).toEqual(expect.arrayContaining(["開始", "終了"]));
    expect(r.diff.changed.some((c) => c.name === "基本設計")).toBe(true); // 連動して動く
    expect(r.diff.deleted.map((d) => d.name)).toEqual(["実装"]);
    expect(r.diff.calendar.length).toBeGreaterThan(0);
    expect(r.diff.project[0]).toMatchObject({ before: "T", after: "新名称" });
    expect(r.diff.counts.deleted).toBe(1);
  });

  it("a no-op produces an empty diff", () => {
    const r = dryRun(base(), parse([{ op: "updateTask", id: "A1", name: "要件" }]), { ctx: ctx() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.diff.counts).toEqual({ added: 0, changed: 0, deleted: 0, other: 0 });
  });
});

describe("categories", () => {
  const withCat = (): GanttDocument => {
    const d = doc([
      { id: "K", kind: "category", parentId: null, name: "フェーズ1", resourceIds: [], dependencies: [] },
      task({ id: "A", parentId: "K", start: "2023-05-22", end: "2023-05-23", name: "要件" }),
      task({ id: "B", start: "2023-05-29", end: "2023-05-30", name: "実装" }),
    ]);
    return d;
  };

  it("parseOps accepts addCategory and requires tempId / name", () => {
    expect(parse([{ op: "addCategory", tempId: "new:1", name: "x", parentId: "K", afterId: "A" }])).toEqual([
      { op: "addCategory", tempId: "new:1", name: "x", parentId: "K", afterId: "A" },
    ]);
    expect(parseOps([{ op: "addCategory", name: "x" }]).ok).toBe(false);
    expect(parseOps([{ op: "addCategory", tempId: "new:1" }]).ok).toBe(false);
  });

  it("addCategory at the end, then addTask under it via its temp id (empty category -> indent)", () => {
    const ops = parse([
      { op: "addCategory", tempId: "new:c", name: "フェーズ2" },
      { op: "addTask", tempId: "new:t", name: "テスト", start: "2023-06-05", end: "2023-06-06", parentId: "new:c" },
      { op: "addTask", tempId: "new:u", name: "リリース", start: "2023-06-07", end: "2023-06-07", parentId: "new:c" },
    ]);
    const r = dryRun(withCat(), ops, { ctx: ctx() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cat = r.after.tasks.find((t) => t.name === "フェーズ2")!;
    expect(cat).toMatchObject({ kind: "category", parentId: null });
    expect(cat.start).toBeUndefined();
    expect(r.after.tasks.filter((t) => t.parentId === cat.id).map((t) => t.name)).toEqual(["テスト", "リリース"]);
    expect(r.diff.added.map((a) => [a.name, a.isCategory === true])).toEqual([
      ["フェーズ2", true],
      ["テスト", false],
      ["リリース", false],
    ]);
    expect(r.diff.added[0]).not.toHaveProperty("start");
  });

  it("addTask with a category as parentId always lands at the end of its children, even if the last child is a category", () => {
    const d = withCat();
    d.tasks.splice(2, 0, { id: "K2", kind: "category", parentId: "K", name: "サブ", resourceIds: [], dependencies: [] });
    const r = dryRun(d, parse([{ op: "addTask", tempId: "new:t", name: "末尾", start: "2023-05-30", end: "2023-05-30", parentId: "K" }]), { ctx: ctx() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const n = r.after.tasks.find((t) => t.name === "末尾")!;
    expect(n.parentId).toBe("K");
    expect(r.after.tasks.map((t) => t.name)).toEqual(["フェーズ1", "要件", "サブ", "末尾", "実装"]);
  });

  it("addTask with both parentId and a category afterId is refused with an explanation", () => {
    const d = withCat();
    d.tasks.splice(2, 0, { id: "K2", kind: "category", parentId: "K", name: "サブ", resourceIds: [], dependencies: [] });
    const r = dryRun(d, parse([{ op: "addTask", tempId: "new:t", name: "x", start: "2023-05-30", end: "2023-05-30", parentId: "K", afterId: "K2" }]), { ctx: ctx() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("UNRESOLVED");
  });

  it("addCategory nested in a category (parentId) and addTask under an existing category", () => {
    const ops = parse([
      { op: "addCategory", tempId: "new:s", name: "サブ", parentId: "K" },
      { op: "addTask", tempId: "new:t", name: "追加", start: "2023-05-24", end: "2023-05-24", parentId: "K" },
    ]);
    const r = dryRun(withCat(), ops, { ctx: ctx() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sub = r.after.tasks.find((t) => t.name === "サブ")!;
    expect(sub.parentId).toBe("K");
    expect(r.after.tasks.find((t) => t.name === "追加")!.parentId).toBe("K");
    expect(findIssues(r.after)).toEqual([]);
  });

  it("addCategory with a non-category parentId is refused", () => {
    const r = dryRun(withCat(), parse([{ op: "addCategory", tempId: "new:1", name: "x", parentId: "B" }]), { ctx: ctx() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("UNRESOLVED");
  });

  it("updateTask on a category: name / notes / colorLabel are fine, dates and the like are rejected", () => {
    const ok = dryRun(withCat(), parse([{ op: "updateTask", id: "K", name: "改名", notes: "n" }]), { ctx: ctx() });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.diff.changed).toHaveLength(1);
      expect(ok.diff.changed[0]).toMatchObject({ name: "改名", isCategory: true });
      expect(ok.diff.changed[0]!.changes.map((c) => c.label)).toEqual(["名前", "詳細"]);
    }
    for (const patch of [{ start: "2023-06-01" }, { durationDays: 3 }, { status: "done" }, { hours: 2 }, { resourceIds: [] }]) {
      const r = dryRun(withCat(), parse([{ op: "updateTask", id: "K", ...patch }]), { ctx: ctx() });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.code).toBe("CATEGORY_NOT_EDITABLE");
    }
  });

  it("dependencies on a category and indenting a category under a task are rejected by the engine", () => {
    const a = dryRun(withCat(), parse([{ op: "addDependency", taskId: "B", predecessorId: "K" }]), { ctx: ctx() });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.failure.code).toBe("CATEGORY_NOT_EDITABLE");
    const b = dryRun(
      doc([
        { id: "K", kind: "category", parentId: null, name: "1", resourceIds: [], dependencies: [] },
        task({ id: "X", parentId: "K", start: "2023-05-22" }),
        { id: "K2", kind: "category", parentId: "K", name: "2", resourceIds: [], dependencies: [] },
      ]), parse([{ op: "arrangeTask", id: "K2", action: "indent" }]), { ctx: ctx() });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.failure.code).toBe("CATEGORY_PARENT_INVALID");
  });

  it("deleting a category shows the category and its tasks as deleted", () => {
    const r = dryRun(withCat(), parse([{ op: "deleteTask", id: "K" }]), { ctx: ctx() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diff.deleted.map((d) => [d.name, d.isCategory === true])).toEqual([
      ["フェーズ1", true],
      ["要件", false],
    ]);
  });
});

describe("setCategory と担当 (assigneeIds)", () => {
  const cdoc = (): GanttDocument => {
    const d = doc([
      { id: "K1", kind: "category", parentId: null, name: "設計", resourceIds: [], dependencies: [] },
      task({ id: "A", parentId: "K1", start: "2023-05-22", end: "2023-05-23", name: "要件" }),
      task({ id: "A1", parentId: "A", start: "2023-05-22", end: "2023-05-22", name: "子" }),
      task({ id: "B", start: "2023-05-29", end: "2023-05-30", name: "実装" }),
    ]);
    d.tasks[1]!.assigneeIds = ["user-x"];
    d.tasks[3]!.assigneeIds = ["user-y", "user-z"];
    return d;
  };

  it("parse: categoryId は ID か null が必要", () => {
    expect(parse([{ op: "setCategory", id: "B", categoryId: null }])).toEqual([{ op: "setCategory", id: "B", categoryId: null }]);
    expect(parse([{ op: "setCategory", id: "B", categoryId: "K1" }])).toEqual([{ op: "setCategory", id: "B", categoryId: "K1" }]);
    expect(parseOps([{ op: "setCategory", id: "B" }]).ok).toBe(false);
    expect(parseOps([{ op: "setCategory", id: "B", categoryId: "" }]).ok).toBe(false);
    expect(parseOps([{ op: "setCategory", id: "B", categoryId: 5 }]).ok).toBe(false);
  });

  it("既存カテゴリへ移し、差分に「カテゴリ」の変更として出る", () => {
    const r = dryRun(cdoc(), parse([{ op: "setCategory", id: "B", categoryId: "K1" }]), { ctx: ctx() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.after.tasks.find((t) => t.id === "B")!.parentId).toBe("K1");
    const ch = r.diff.changed.find((c) => c.name === "実装")!;
    expect(ch.changes).toEqual([{ label: "カテゴリ", before: "カテゴリなし", after: "設計" }]);
  });

  it("新しいカテゴリ (仮 ID) を作って移す。null でカテゴリなしへ戻す", () => {
    const r = dryRun(
      cdoc(),
      parse([
        { op: "addCategory", tempId: "new:1", name: "実装フェーズ" },
        { op: "setCategory", id: "B", categoryId: "new:1" },
        { op: "setCategory", id: "A", categoryId: null },
      ]),
      { ctx: ctx() },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byName = (n: string) => r.after.tasks.find((t) => t.name === n)!;
    expect(byName("実装")!.parentId).toBe(byName("実装フェーズ").id);
    expect(byName("要件").parentId).toBeNull();
    expect(byName("子").parentId).toBe("A"); // サブツリーごと
    const top = r.after.tasks.filter((t) => t.parentId === null).map((t) => t.kind === "category");
    expect(top).toEqual([...top].sort((a, b) => Number(b) - Number(a))); // カテゴリが先
  });

  it("サブタスク・カテゴリ自身・カテゴリでない移動先は engine が拒否する", () => {
    const sub = dryRun(cdoc(), parse([{ op: "setCategory", id: "A1", categoryId: null }]), { ctx: ctx() });
    expect(sub.ok).toBe(false);
    if (!sub.ok) expect(sub.failure.code).toBe("SUBTASK_CATEGORY");
    const cat = dryRun(cdoc(), parse([{ op: "setCategory", id: "K1", categoryId: null }]), { ctx: ctx() });
    expect(cat.ok).toBe(false);
    if (!cat.ok) expect(cat.failure.code).toBe("CATEGORY_NOT_EDITABLE");
    const notCat = dryRun(cdoc(), parse([{ op: "setCategory", id: "B", categoryId: "A" }]), { ctx: ctx() });
    expect(notCat.ok).toBe(false);
    const unknown = dryRun(cdoc(), parse([{ op: "setCategory", id: "B", categoryId: "nope" }]), { ctx: ctx() });
    expect(unknown.ok).toBe(false);
  });

  it("AI の操作で既存タスクの assigneeIds が失われない (更新・移動・並べ替え・追加・削除を通して)", () => {
    const r = dryRun(
      cdoc(),
      parse([
        { op: "updateTask", id: "B", name: "実装 (改)", start: "2023-06-05", end: "2023-06-06", notes: "メモ", resourceIds: [] },
        { op: "shiftTask", id: "A", deltaDays: 7 },
        { op: "arrangeTask", id: "A", action: "outdent" },
        { op: "arrangeTask", id: "A", action: "indent" },
        { op: "setCategory", id: "B", categoryId: "K1" },
        { op: "addTask", tempId: "new:1", name: "新規", start: "2023-06-07", end: "2023-06-07", afterId: "B" },
        { op: "addDependency", taskId: "B", predecessorId: "A" },
        { op: "updateTask", id: "A1", status: "doing" },
        { op: "deleteTask", id: "A1" },
      ]),
      { ctx: ctx() },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.failure));
    expect(r.after.tasks.find((t) => t.id === "A")!.assigneeIds).toEqual(["user-x"]);
    expect(r.after.tasks.find((t) => t.id === "B")!.assigneeIds).toEqual(["user-y", "user-z"]);
    expect(r.after.tasks.find((t) => t.name === "新規")!.assigneeIds).toBeUndefined();
  });

  it("担当を変える操作は語彙に無い (assigneeIds / setAssignees は未知)", () => {
    expect(parseOps([{ op: "setAssignees", id: "B", userIds: ["u"] }]).ok).toBe(false);
    const ops = parse([{ op: "updateTask", id: "B", name: "x", assigneeIds: ["hacker"] }]);
    const r = dryRun(cdoc(), ops, { ctx: ctx() });
    expect(r.ok && r.after.tasks.find((t) => t.id === "B")!.assigneeIds).toEqual(["user-y", "user-z"]);
  });
});

describe("マイルストーン・状態の操作 (AI)", () => {
  const d0 = (): GanttDocument => {
    const d = doc([
      { id: "K", kind: "category", parentId: null, name: "フェーズ", resourceIds: [], dependencies: [] },
      task({ id: "A", parentId: "K", start: "2023-05-22", end: "2023-05-23", name: "要件" }),
      { id: "M", kind: "milestone", parentId: "K", name: "中間", start: "2023-05-30", end: "2023-05-30", resourceIds: [], dependencies: [] },
      task({ id: "B", start: "2023-06-05", end: "2023-06-06", name: "実装" }),
    ]);
    d.colorLabels = [{ id: "C1", name: "重要", color: "#ff0000" }];
    return d;
  };
  it("parse: addMilestone は date 必須。status は 3 値のみ。setProgress は未知の操作", () => {
    expect(parse([{ op: "addMilestone", tempId: "new:1", name: "x", date: "2023-06-01" }])).toHaveLength(1);
    expect(parseOps([{ op: "addMilestone", tempId: "new:1", name: "x" }]).ok).toBe(false);
    expect(parseOps([{ op: "addMilestone", tempId: "new:1", name: "x", date: "2023-02-30" }]).ok).toBe(false);
    expect(parseOps([{ op: "updateTask", id: "A", status: "finished" }]).ok).toBe(false);
    expect(parse([{ op: "updateTask", id: "A", status: "done" }])).toEqual([{ op: "updateTask", id: "A", status: "done" }]);
    expect(parseOps([{ op: "setProgress", id: "A", progress: 5 }]).ok).toBe(false);
    // 廃止した progress は updateTask の項目として扱わない (他に項目が無ければ「更新する項目がありません」)
    expect(parseOps([{ op: "updateTask", id: "A", progress: 50 }]).ok).toBe(false);
  });
  it("addMilestone: カテゴリの子の末尾に追加し (parentId)、tempId で後続から参照でき、差分に「マイルストーン」として出る", () => {
    const r = dryRun(d0(), parse([
      { op: "addMilestone", tempId: "new:m", name: "リリース", date: "2023-06-30", parentId: "K", notes: "本番", colorLabelId: "C1" },
      { op: "updateTask", id: "new:m", name: "リリース (改)", date: "2023-07-01" },
    ]), { ctx: ctx() });
    if (!r.ok) throw new Error(JSON.stringify(r.failure));
    const m = r.after.tasks.find((t) => t.kind === "milestone" && t.name === "リリース (改)")!;
    expect(m).toMatchObject({ parentId: "K", start: "2023-07-01", end: "2023-07-01", notes: "本番", colorLabelId: "C1" });
    expect(r.diff.added.find((a) => a.name === "リリース (改)")).toMatchObject({ isMilestone: true });
  });
  it("addMilestone: 位置 (afterId) とカテゴリ以外の parentId の扱い", () => {
    const r = dryRun(d0(), parse([{ op: "addMilestone", tempId: "new:m", name: "x", date: "2023-06-30", afterId: "B" }]), { ctx: ctx() });
    expect(r.ok && r.after.tasks.find((t) => t.name === "x")!.parentId).toBeNull();
    const bad = dryRun(d0(), parse([{ op: "addMilestone", tempId: "new:m", name: "x", date: "2023-06-30", parentId: "B" }]), { ctx: ctx() });
    expect(bad.ok).toBe(false);
  });
  it("updateTask: マイルストーンは名前・日付・詳細・色だけ。それ以外 (start / hours / status など) は engine が拒否", () => {
    const ok = dryRun(d0(), parse([{ op: "updateTask", id: "M", name: "中間 (改)", date: "2023-06-01", notes: "n", colorLabelId: "C1" }]), { ctx: ctx() });
    expect(ok.ok && ok.after.tasks.find((t) => t.id === "M")).toMatchObject({ name: "中間 (改)", start: "2023-06-01", end: "2023-06-01", notes: "n", colorLabelId: "C1" });
    if (ok.ok) expect(ok.diff.changed[0]).toMatchObject({ isMilestone: true });
    for (const patch of [{ start: "2023-06-01" }, { hours: 1 }, { status: "done" }, { resourceIds: [] }]) {
      const r = dryRun(d0(), parse([{ op: "updateTask", id: "M", ...patch }]), { ctx: ctx() });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.code).toBe("MILESTONE_NOT_EDITABLE");
    }
  });
  it("updateTask: status を変更でき、差分に「状態」の変更として出る。date はマイルストーン以外では使えない。親・カテゴリは拒否", () => {
    const r = dryRun(d0(), parse([{ op: "updateTask", id: "B", status: "done" }]), { ctx: ctx() });
    expect(r.ok && r.after.tasks.find((t) => t.id === "B")!.status).toBe("done");
    if (r.ok) expect(r.diff.changed[0]!.changes).toEqual([{ label: "状態", before: "未着手", after: "完了" }]);
    expect(dryRun(d0(), parse([{ op: "updateTask", id: "B", date: "2023-06-01" }]), { ctx: ctx() }).ok).toBe(false);
    const cat = dryRun(d0(), parse([{ op: "updateTask", id: "K", status: "done" }]), { ctx: ctx() });
    expect(cat.ok === false && cat.failure.code).toBe("CATEGORY_NOT_EDITABLE");
    const d = d0();
    d.tasks.push(task({ id: "B1", parentId: "B", start: "2023-06-05" }));
    const parent = dryRun(d, parse([{ op: "updateTask", id: "B", status: "done" }]), { ctx: ctx() });
    expect(parent.ok === false && parent.failure.code).toBe("PARENT_NOT_EDITABLE");
  });
  it("addMilestone 後に addDependency でマイルストーンを指定すると拒否", () => {
    const r = dryRun(d0(), parse([{ op: "addDependency", taskId: "B", predecessorId: "M" }]), { ctx: ctx() });
    expect(r.ok === false && r.failure.code).toBe("MILESTONE_NOT_EDITABLE");
  });
});
