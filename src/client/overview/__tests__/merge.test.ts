import { describe, expect, it } from "vitest";
import { cat, doc as mkDoc, ms, task } from "../../../shared/engine/__tests__/fixtures";
import { buildTreeIndex } from "../../../shared/engine";
import type { GanttDocument } from "../../../shared/model/types";
import { UNCATEGORIZED_ROW_ID } from "../../components/chart/layout";
import { buildOverviewLayout, collapseKey, overviewRowIds, projectRowKey, rowKey, type OverviewProject } from "../merge";

const TODAY = "2023-05-22";
const ok = (id: string, name: string, doc: GanttDocument): OverviewProject => ({ id, name, state: { status: "ok", doc } });
const build = (projects: OverviewProject[], collapsed: string[] = [], zoom: "day" | "week" | "month" = "day") =>
  buildOverviewLayout({ projects, zoom, valueColumn: "duration", collapsed: new Set(collapsed), users: null }, TODAY);
const names = (l: ReturnType<typeof build>) => l.layout.rows.map((r) => r.name);

// タスクの並びが「タスク → マイルストーン → サブカテゴリ」と入り乱れた doc。
const messy = (): GanttDocument =>
  mkDoc([
    cat("K"),
    task({ id: "t1", parentId: "K", start: "2023-05-22", end: "2023-05-23", name: "T1" }),
    cat("Sub", "K", "Sub"),
    task({ id: "s1", parentId: "Sub", start: "2023-05-24", name: "S1" }),
    ms("m1", "2023-05-30", "K", "M1"),
    task({ id: "t2", parentId: "K", start: "2023-05-25", name: "T2" }),
    ms("m2", "2023-05-31", "K", "M2"),
    task({ id: "u1", start: "2023-05-22", name: "U1" }),
    ms("um", "2023-06-01", null, "UM"),
  ]);

describe("行の階層と順序", () => {
  it("プロジェクト > カテゴリ > マイルストーン > タスク > サブカテゴリ、トップレベルはカテゴリ → カテゴリなし(マイルストーン → タスク)", () => {
    const l = build([ok("A", "プロジェクトA", messy())]);
    expect(names(l)).toEqual(["プロジェクトA", "K", "M1", "M2", "T1", "T2", "Sub", "S1", "カテゴリなし", "UM", "U1"]);
    const rows = l.layout.rows;
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 2, 2, 2, 2, 3, 1, 1, 1]);
    expect(rows[0]).toMatchObject({ isProject: true, href: "/s/A", index: 0, y: 0 });
    expect(rows.map((r) => r.index)).toEqual(rows.map((_, i) => i));
  });
  it("各種別の中の相対順は保つ (元の doc の順)", () => {
    const d = mkDoc([
      task({ id: "b", start: "2023-05-22", name: "b" }),
      ms("y", "2023-05-22", null, "y"),
      task({ id: "a", start: "2023-05-22", name: "a" }),
      ms("x", "2023-05-22", null, "x"),
    ]);
    expect(names(build([ok("A", "A", d)]))).toEqual(["A", "y", "x", "b", "a"]);
  });
  it("プロジェクトの並びは入力順。折りたたんだプロジェクトは見出しだけ", () => {
    const l = build([ok("A", "A", messy()), ok("B", "B", messy())], [projectRowKey("A")]);
    const n = names(l);
    expect(n.slice(0, 2)).toEqual(["A", "B"]);
    expect(l.layout.rows[0]).toMatchObject({ collapsed: true, isParent: true });
    expect(l.layout.bars.every((b) => b.taskId.startsWith("B:"))).toBe(true);
  });
  it("カテゴリ・親タスクの折りたたみはそのスケジュールだけに効く", () => {
    const d = (): GanttDocument =>
      mkDoc([cat("K"), task({ id: "P", parentId: "K", name: "P" }), task({ id: "c", parentId: "P", start: "2023-05-22", name: "c" })]);
    const l = build([ok("A", "A", d()), ok("B", "B", d())], [collapseKey(rowKey("A", "K"))]);
    expect(names(l)).toEqual(["A", "K", "B", "K", "P", "c"]);
    const l2 = build([ok("A", "A", d()), ok("B", "B", d())], [collapseKey(rowKey("B", "P"))]);
    expect(names(l2)).toEqual(["A", "K", "P", "c", "B", "K", "P"]);
  });
  it("overviewRowIds: 折りたたんだ行の子孫は含まない", () => {
    const ix = buildTreeIndex(messy());
    expect(overviewRowIds(ix, new Set(["K"]))).toEqual(["K", "um", "u1"]);
  });
  it("カテゴリが無ければ「カテゴリなし」の見出しは出ない", () => {
    const l = build([ok("A", "A", mkDoc([task({ id: "t", start: "2023-05-22", name: "t" })]))]);
    expect(names(l)).toEqual(["A", "t"]);
  });
});

describe("ID の衝突", () => {
  it("同じタスク ID のスケジュールを結合しても行・バー・矢印が衝突しない", () => {
    const d = (): GanttDocument =>
      mkDoc([
        task({ id: "same1", start: "2023-05-22", end: "2023-05-23", name: "x" }),
        task({ id: "same2", start: "2023-05-24", end: "2023-05-25", deps: ["same1"], name: "y" }),
      ]);
    const l = build([ok("A", "A", d()), ok("B", "B", d())]);
    const ids = l.layout.rows.map((r) => r.taskId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(l.layout.bars.map((b) => b.taskId)).toEqual(["A:same1", "A:same2", "B:same1", "B:same2"]);
    expect(l.layout.arrows.map((a) => [a.predId, a.succId])).toEqual([
      ["A:same1", "A:same2"],
      ["B:same1", "B:same2"],
    ]);
    // 矢印は同じスケジュールの行の間だけ
    const a = l.layout.arrows[1]!;
    expect(l.layout.rows[a.fromIndex]!.taskId).toBe("B:same1");
    expect(l.layout.rows[a.toIndex]!.taskId).toBe("B:same2");
    expect(a.d).toContain(`${(a.toIndex) * 26 + 13}`);
  });
  it("「カテゴリなし」の仮想行もスケジュールごとに別の ID", () => {
    const d = (): GanttDocument => mkDoc([cat("K"), task({ id: "t", start: "2023-05-22" })]);
    const l = build([ok("A", "A", d()), ok("B", "B", d())]);
    const virt = l.layout.rows.filter((r) => r.virtual).map((r) => r.taskId);
    expect(virt).toEqual([`A:${UNCATEGORIZED_ROW_ID}`, `B:${UNCATEGORIZED_ROW_ID}`]);
  });
  it("大文字小文字だけ違う折りたたみキーは同じ (idKey)", () => {
    expect(collapseKey("A:AbC")).toBe(collapseKey("A:abc"));
    expect(collapseKey("A")).toBe("A");
  });
});

describe("カレンダーと時間軸", () => {
  it("期間・工数はスケジュールごとのカレンダー、網掛けは土日のみ", () => {
    // 2023-05-26 (金) - 05-29 (月): 土日休みなら 2d、休みなしなら 4d
    const withSat = (): GanttDocument => {
      const d = mkDoc([task({ id: "t", start: "2023-05-26", end: "2023-05-29", name: "t" })]);
      return d;
    };
    const a = withSat(); // 土日休み → 5d
    const b = withSat();
    b.project.calendar = { weekends: [], holidays: [] }; // 休みなし → 7d
    const c = withSat();
    delete c.project.calendar; // カレンダー無効 → 7d
    const l = build([ok("A", "A", a), ok("B", "B", b), ok("C", "C", c)]);
    const dur = l.layout.rows.filter((r) => !r.isProject).map((r) => r.valueText);
    expect(dur[0]).not.toBe(dur[1]);
    expect(dur[1]).toBe(dur[2]);
    // 土日の帯 (day zoom): 範囲内の土日の数と一致
    const { range, nonWorking } = l.layout;
    let weekend = 0;
    for (let d = new Date(`${range.start}T00:00:00Z`); d <= new Date(`${range.end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) weekend++;
    }
    expect(nonWorking.reduce((s, b2) => s + b2.w / l.layout.dayWidth, 0)).toBe(weekend);
  });
  it("表示範囲は全スケジュールの和、バーの位置は共通の軸", () => {
    const a = mkDoc([task({ id: "t", start: "2023-05-22", name: "t" })]);
    const b = mkDoc([task({ id: "t", start: "2023-09-04", name: "t" })]);
    const l = build([ok("A", "A", a), ok("B", "B", b)]);
    expect(l.earliest).toBe("2023-05-22");
    const [ba, bb] = l.layout.bars;
    expect(bb!.x - ba!.x).toBe(l.layout.dayWidth * 105);
    expect(l.layout.range.start <= "2023-05-22").toBe(true);
    expect(l.layout.range.end >= "2023-09-04").toBe(true);
  });
  it("完了・期限超過・担当・マイルストーンの表示情報を引き継ぐ", () => {
    const d = mkDoc([
      task({ id: "late", start: "2023-05-01", end: "2023-05-02", name: "late" }),
      task({ id: "fin", start: "2023-05-01", end: "2023-05-02", status: "done", name: "fin" }),
      ms("m", "2023-05-30", null, "M"),
    ]);
    d.tasks[0]!.assigneeIds = ["u1"];
    const l = build([{ ...ok("A", "A", d) }].map((p) => p));
    const l2 = buildOverviewLayout(
      { projects: [ok("A", "A", d)], zoom: "day", valueColumn: "duration", collapsed: new Set(), users: new Map([["u1", "田中"]]) },
      TODAY,
    );
    const late = l2.layout.rows.find((r) => r.name === "late")!;
    expect(late.overdue.length).toBeGreaterThan(0);
    expect(late.assignees).toBe("田中");
    expect(l2.layout.bars.find((b) => b.taskId === "A:late")!.assigneeText).toBe("田中");
    expect(l2.layout.rows.find((r) => r.name === "fin")!.done).toBe(true);
    expect(l.layout.bars.find((b) => b.kind === "milestone")).toBeTruthy();
    expect(l.layout.rows.every((r) => r.commentCount === 0)).toBe(true);
  });
});

describe("取得できなかったスケジュール", () => {
  it("失敗・見つからない・読み込み中は見出し行に注記、他は表示される", () => {
    const l = build([
      { id: "X", name: "失敗", state: { status: "error", reason: "failed" } },
      { id: "N", name: "消えた", state: { status: "error", reason: "notfound" } },
      { id: "L", name: "待ち", state: { status: "loading" } },
      ok("A", "A", messy()),
    ]);
    const rows = l.layout.rows;
    expect(rows.slice(0, 3).map((r) => [r.name, r.note, r.noteTone])).toEqual([
      ["失敗", "読み込めませんでした", "error"],
      ["消えた", "見つかりません", "error"],
      ["待ち", "読み込み中...", "muted"],
    ]);
    expect(rows[3]!.name).toBe("A");
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.map((r) => r.index)).toEqual(rows.map((_, i) => i));
  });
  it("全部失敗でも落ちない (今日を基準にした空の軸)", () => {
    const l = build([{ id: "X", name: "失敗", state: { status: "error", reason: "failed" } }]);
    expect(l.layout.rows).toHaveLength(1);
    expect(l.layout.bars).toHaveLength(0);
    expect(l.earliest).toBeNull();
    expect(l.layout.todayX).not.toBeNull();
  });
  it("壊れた doc は例外にせずそのスケジュールだけ注記", () => {
    const bad = { version: 1, project: { name: "x" }, resources: [], colorLabels: [], tasks: [{ id: "a", name: "a", kind: "task" }] } as unknown as GanttDocument;
    const l = build([ok("B", "bad", bad), ok("A", "A", messy())]);
    expect(l.layout.rows.some((r) => r.name === "A")).toBe(true);
    expect(l.layout.rows.find((r) => r.taskId === "B")).toBeTruthy();
  });
  it("2000 行でも構築は速い", () => {
    const tasks = [];
    for (let i = 0; i < 100; i++) tasks.push(cat(`c${i}`));
    for (let i = 0; i < 1900; i++) tasks.push(task({ id: `t${i}`, parentId: `c${i % 100}`, start: "2023-05-22", end: "2023-05-30", deps: i >= 100 ? [`t${i - 100}`] : [], name: `t${i}` }));
    const t0 = performance.now();
    const l = build([ok("A", "A", mkDoc(tasks))], [], "day");
    expect(l.layout.rows.length).toBe(2001);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
