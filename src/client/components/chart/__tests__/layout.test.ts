import { describe, expect, it } from "vitest";
import sample from "../../../../../schema/examples/sample.json";
import { compileCalendar, deriveAll, loadDocument } from "../../../../shared/engine";
import { t } from "../../../i18n";
import type { GanttDocument, Zoom } from "../../../../shared/model/types";
import { cat as mkCat, doc as mkDoc, ms, task } from "../../../../shared/engine/__tests__/fixtures";
import { findViolations } from "../../../../shared/engine";
import { dateAtX, computeLayout, computeRange, fitText, UNCATEGORIZED_ROW_ID, xOfDate } from "../layout";

const r = loadDocument(structuredClone(sample) as unknown as GanttDocument);
if (!r.ok) throw new Error("sample invalid");
const doc = r.doc;
const wc = compileCalendar(doc.project.calendar);
const derived = deriveAll(doc, wc);
const TODAY = "2023-05-22";
const INITIATION = "1a95";

function layout(zoom: Zoom, collapsed: string[] = [], valueColumn: "duration" | "hours" = "duration") {
  return computeLayout({ doc, derived, wc, zoom, collapsed: new Set(collapsed), valueColumn }, TODAY);
}
const idStartingWith = (p: string) => doc.tasks.find((t) => t.id.startsWith(p))!.id;

describe("computeLayout (sample, day zoom)", () => {
  const l = layout("day");
  it("range, widths, rows", () => {
    expect(l.range.start).toBe("2023-05-15");
    expect(l.dayWidth).toBe(68);
    expect(l.rows).toHaveLength(31);
    expect(l.rows[0]!.y).toBe(0);
    expect(l.rows[5]!.y).toBe(130);
    expect(l.rows[5]!.rowNo).toBe(6);
    expect(l.bodyHeight).toBe(31 * 26);
    expect(xOfDate(l, "2023-05-22")).toBe(476);
    expect(dateAtX(l, 476 + 10)).toBe("2023-05-22");
    expect(l.todayX).toBe(476);
  });
  it("bars", () => {
    const goals = l.bars[2]!;
    expect(goals.kind).toBe("leaf");
    expect(goals.x).toBe(476);
    expect(goals.w).toBe(68);
    expect(goals.y).toBe(2 * 26 + 5);
    const plan = l.bars[0]!;
    expect(plan.kind).toBe("summary");
    expect(plan.x).toBe(476);
    expect(plan.w).toBe(12 * 68);
  });
  it("arrow with detour (Define goals -> Kickoff meeting)", () => {
    const a = l.arrows.find((x) => x.succId.startsWith("4613") && x.predId.startsWith("4652"))!;
    expect(a.d).toBe("M 544 65 H 552 V 104 H 536 V 117 H 544");
    expect(a.head).toBe("544,117 538,113.5 538,120.5");
    expect(a.violated).toBe(false);
  });
  it("direct arrow when there is enough room (UI mockups -> Database design, across a weekend)", () => {
    const a = l.arrows.find((x) => x.succId.startsWith("d0d4") && x.predId.startsWith("31ca"))!;
    const y1 = a.fromIndex * 26 + 13;
    const y2 = a.toIndex * 26 + 13;
    expect(a.d).toBe(`M 816 ${y1} H 824 V ${y2} H 952`);
    expect(a.head).toBe(`952,${y2} 946,${y2 - 3.5} 946,${y2 + 3.5}`);
  });
  it("header cells", () => {
    expect(l.headerTop[0]!.w).toBe(476);
    expect(l.headerTop[0]!.label).toBe(t("header.weekRange", { year: 2023, from: t("header.monthDay", { month: 5, day: 15 }), to: t("header.monthDay", { month: 5, day: 21 }) }));
    expect(l.headerBottom[7]!.label).toBe(`22 (${t("weekday.1")})`);
    expect(l.headerBottom[5]!.muted).toBe(true);
    expect(l.nonWorking[0]).toEqual({ x: 5 * 68, w: 2 * 68 });
  });
  it("value column", () => {
    expect(l.rows[2]!.valueText).toBe("1d");
    const h = layout("day", [], "hours");
    expect(h.rows[2]!.valueText).toBe("8h");
  });
});

describe("computeLayout (other zooms)", () => {
  it("week: bottom cell width 140, top = months", () => {
    const l = layout("week");
    expect(l.dayWidth).toBe(20);
    expect(l.headerBottom[0]!.w).toBe(140);
    expect(l.headerBottom[0]!.label).toBe("5/15–5/21");
    expect(l.headerTop[0]!.label).toBe(t("header.month", { year: 2023, month: 5 }));
    expect(l.headerTop[0]!.w).toBe(17 * 20); // 5/15..5/31 clipped at range start
  });
  it("month: range snaps to month boundaries, header year/month", () => {
    const l = layout("month");
    expect(l.range.start).toBe("2023-05-01");
    expect(l.range.end.endsWith("-31") || l.range.end.endsWith("-30")).toBe(true);
    expect(l.headerBottom[0]).toMatchObject({ x: 0, w: 31 * 6, label: t("header.monthShort", { month: 5 }) });
    expect(l.headerTop[0]!.label).toBe(t("header.year", { year: 2023 }));
    expect(l.nonWorking).toEqual([]);
  });
});

describe("collapse", () => {
  const initiation = idStartingWith(INITIATION);
  const l = layout("day", [initiation]);
  it("hides children", () => {
    expect(l.rows).toHaveLength(26);
    expect(l.rows[1]!.collapsed).toBe(true);
    expect(l.rows[2]!.name).toBe("Planning");
    // serial number among all tasks, unaffected by collapsing
    expect(l.rows[2]!.rowNo).toBe(derived.order.indexOf(l.rows[2]!.taskId) + 1);
    expect(l.rows[2]!.rowNo).toBeGreaterThan(3);
  });
  it("arrows to hidden tasks attach to the collapsed ancestor; internal ones vanish", () => {
    // Requirements gathering depends on Kickoff meeting (child of Initiation)
    const a = l.arrows.find((x) => x.succId.startsWith("3cb7") && x.predId.startsWith("4613"))!;
    expect(a.fromIndex).toBe(1);
    expect(l.arrows.some((x) => x.succId.startsWith("4613"))).toBe(false);
    for (const x of l.arrows) expect(x.fromIndex).not.toBe(x.toIndex);
  });
});

function layoutOf(d: GanttDocument, zoom: Zoom, extra: { collapsed?: string[]; prev?: ReturnType<typeof computeLayout> } = {}) {
  const w = compileCalendar(d.project.calendar);
  return computeLayout(
    { doc: d, derived: deriveAll(d, w), wc: w, zoom, collapsed: new Set(extra.collapsed ?? []), valueColumn: "duration" },
    TODAY,
    extra.prev,
  );
}

describe("non-working bands", () => {
  it("weekends form bands; an adjacent holiday merges into the weekend band", () => {
    const d = mkDoc([task({ id: "A", start: "2023-05-22", end: "2023-05-23" })]);
    expect(layoutOf(d, "day").nonWorking[0]).toEqual({ x: 5 * 68, w: 2 * 68 });
    const h = { ...d, project: { ...d.project, calendar: { weekends: [0, 6], holidays: ["2023-05-22", "2023-05-15"] } } };
    const l = layoutOf(h as GanttDocument, "day");
    expect(l.nonWorking[0]).toEqual({ x: 0, w: 68 }); // holiday on the first day of the range
    expect(l.nonWorking[1]).toEqual({ x: 5 * 68, w: 3 * 68 }); // Sat, Sun, holiday Monday
  });
  it("a trailing non-working run at the range end is closed; none without a calendar", () => {
    const d = mkDoc([task({ id: "A", start: "2023-05-22" })]);
    const l = layoutOf(d, "day");
    const last = l.nonWorking[l.nonWorking.length - 1]!;
    expect(last.x + last.w).toBe(l.timelineWidth); // range ends on a Sunday
    expect(layoutOf(mkDoc([task({ id: "A", start: "2023-05-22" })], { calendar: false }), "day").nonWorking).toEqual([]);
  });
});

describe("violated dependency arrows", () => {
  it("marks an arrow whose successor starts before the predecessor ends", () => {
    const d = mkDoc([
      task({ id: "A", start: "2023-05-22", end: "2023-05-24" }),
      task({ id: "B", start: "2023-05-23", deps: ["A"] }),
      task({ id: "C", start: "2023-05-26", deps: ["A"] }),
    ]);
    expect(findViolations(d, compileCalendar(d.project.calendar))).toHaveLength(1);
    const l = layoutOf(d, "day");
    expect(l.arrows.find((a) => a.succId === "B")!.violated).toBe(true);
    expect(l.arrows.find((a) => a.succId === "C")!.violated).toBe(false);
  });
});

describe("month / week boundaries", () => {
  const sum = (cells: { w: number }[]) => cells.reduce((a, c) => a + c.w, 0);
  it("month zoom: range snaps to month start / end across a year boundary", () => {
    const d = mkDoc([task({ id: "A", start: "2023-12-20", end: "2024-01-10" })]);
    const l = layoutOf(d, "month");
    expect(l.range.start).toBe("2023-12-01"); // 12-20 minus 7 days
    expect(l.range.end).toBe("2024-03-31"); // 01-10 plus 60 days = 03-10 -> month end
    expect(sum(l.headerBottom)).toBe(l.timelineWidth);
    expect(sum(l.headerTop)).toBe(l.timelineWidth);
    expect(l.headerTop.map((c) => c.label)).toEqual([t("header.year", { year: 2023 }), t("header.year", { year: 2024 })]);
    expect(l.headerTop[0]!.w).toBe(31 * 6);
    expect(l.headerBottom).toHaveLength(4);
  });
  it("week zoom: months are clipped at the range edges and cells tile the width", () => {
    const d = mkDoc([task({ id: "A", start: "2023-05-31", end: "2023-06-02" })]);
    const l = layoutOf(d, "week");
    expect(l.range.start).toBe("2023-05-22"); // Monday on/before 05-24
    expect(l.range.end).toBe("2023-07-02"); // Sunday on/after 06-30
    expect(l.headerBottom).toHaveLength(6);
    expect(sum(l.headerBottom)).toBe(l.timelineWidth);
    expect(sum(l.headerTop)).toBe(l.timelineWidth);
    expect(l.headerTop[0]!.w).toBe(10 * 20); // 05-22..05-31
    expect(l.headerTop[1]!.w).toBe(30 * 20); // 06-01..06-30
    expect(l.headerTop[2]!.w).toBe(2 * 20); // 07-01..07-02
  });
  it("computeRange falls back to today without tasks", () => {
    const d = mkDoc([]);
    const r = computeRange(deriveAll(d, compileCalendar(d.project.calendar)), "day", TODAY);
    expect(r.start).toBe("2023-05-15");
    expect(r.end).toBe("2023-06-25");
  });
});

describe("reference stability (prev layout)", () => {
  it("same input -> identical layout, rows, bars and arrows", () => {
    const a = layout("day");
    const b = computeLayout(
      { doc, derived, wc, zoom: "day", collapsed: new Set(), valueColumn: "duration" },
      TODAY,
      a,
    );
    expect(b).toBe(a);
  });
  it("a changed task keeps the references of unchanged rows / bars", () => {
    const d = mkDoc([
      task({ id: "A", start: "2023-05-22", end: "2023-05-23" }),
      task({ id: "B", start: "2023-05-29" }),
      task({ id: "C", start: "2023-05-30" }),
    ]);
    const a = layoutOf(d, "day");
    const moved = {
      ...d,
      tasks: d.tasks.map((x) => (x.id === "C" ? { ...x, start: "2023-05-31", end: "2023-05-31" } : x)),
    } as GanttDocument;
    const b = layoutOf(moved, "day", { prev: a });
    expect(b).not.toBe(a);
    expect(b.rows).toBe(a.rows); // names / values unchanged
    expect(b.bars).not.toBe(a.bars);
    expect(b.bars[0]).toBe(a.bars[0]);
    expect(b.bars[1]).toBe(a.bars[1]);
    expect(b.bars[2]).not.toBe(a.bars[2]);
    expect(b.headerBottom).toBe(a.headerBottom);
    expect(b.nonWorking).toBe(a.nonWorking);
  });
});

describe("computeLayout: カテゴリ", () => {
  const cdoc = mkDoc([
    { id: "K", kind: "category", parentId: null, name: "見出し", resourceIds: [], dependencies: [] },
    task({ id: "A", parentId: "K", start: "2023-05-22", end: "2023-05-23" }),
    task({ id: "B", parentId: "K", start: "2023-05-24", end: "2023-05-25", deps: ["A"] }),
    { id: "E", kind: "category", parentId: null, name: "空", resourceIds: [], dependencies: [] },
    task({ id: "T", start: "2023-05-29", deps: ["B"] }),
  ]);
  const cwc = compileCalendar(cdoc.project.calendar);
  const cderived = deriveAll(cdoc, cwc);
  const lay = (collapsed: string[] = []) =>
    computeLayout({ doc: cdoc, derived: cderived, wc: cwc, zoom: "day", collapsed: new Set(collapsed), valueColumn: "duration" }, TODAY);

  it("カテゴリ行は isCategory で値が空、バーは無い (rows と bars は 1:1 でなくなる)", () => {
    const l = lay();
    expect(l.rows.map((r) => [r.taskId, r.isCategory, r.valueText === ""])).toEqual([
      ["K", true, true],
      ["A", false, false],
      ["B", false, false],
      ["E", true, true],
      [UNCATEGORIZED_ROW_ID, false, true], // カテゴリがあり、カテゴリなしのタスクもあるので仮想の見出し行が入る
      ["T", false, false],
    ]);
    expect(l.rows[0]!.isParent).toBe(true);
    expect(l.rows[3]!.isParent).toBe(false);
    expect(l.bars.map((b) => b.taskId)).toEqual(["A", "B", "T"]);
    expect(l.bars.map((b) => b.rowIndex)).toEqual([1, 2, 5]);
    expect(l.rows.map((r) => r.y)).toEqual([0, 26, 52, 78, 104, 130]);
    expect(l.bodyHeight).toBe(6 * 26);
  });
  it("矢印はバー行を基準に引かれる (カテゴリの行番号に影響されない)", () => {
    const l = lay();
    expect(l.arrows.map((a) => [a.succId, a.predId, a.fromIndex, a.toIndex])).toEqual([
      ["B", "A", 1, 2],
      ["T", "B", 2, 5],
    ]);
  });
  it("折りたたむと配下の行が隠れ、隠れたタスクの依存矢印はバーの無いカテゴリ行へ寄せずに省く", () => {
    const l = lay(["K"]);
    expect(l.rows.map((r) => r.taskId)).toEqual(["K", "E", UNCATEGORIZED_ROW_ID, "T"]);
    expect(l.rows[0]!.collapsed).toBe(true);
    expect(l.arrows).toEqual([]);
  });
  it("仮想行: 名前・行番号なし・選択不可の印。コメント/担当は持たない", () => {
    const v = lay().rows.find((r) => r.taskId === UNCATEGORIZED_ROW_ID)!;
    expect(v).toMatchObject({ virtual: true, name: "カテゴリなし", isCategory: false, isParent: false, collapsed: false, commentCount: 0, assignees: "" });
  });
  it("カテゴリが無い doc / カテゴリなしのタスクが無い doc では仮想行を出さない", () => {
    const plain = mkDoc([task({ id: "A", start: "2023-05-22" }), task({ id: "B", start: "2023-05-23" })]);
    const pl = computeLayout({ doc: plain, derived: deriveAll(plain, cwc), wc: cwc, zoom: "day", collapsed: new Set(), valueColumn: "duration" }, TODAY);
    expect(pl.rows.some((r) => r.virtual)).toBe(false);
    expect(pl.rows.map((r) => r.y)).toEqual([0, 26]);
    const onlyCats = mkDoc([{ id: "K", kind: "category", parentId: null, name: "k", resourceIds: [], dependencies: [] }, task({ id: "A", parentId: "K", start: "2023-05-22" })]);
    const ol = computeLayout({ doc: onlyCats, derived: deriveAll(onlyCats, cwc), wc: cwc, zoom: "day", collapsed: new Set(), valueColumn: "duration" }, TODAY);
    expect(ol.rows.some((r) => r.virtual)).toBe(false);
  });
  it("未正規化の doc (カテゴリが後ろ) でも、行の順序と仮想行の位置が正しい", () => {
    const messy = mkDoc([
      task({ id: "T", start: "2023-05-29" }),
      { id: "K", kind: "category", parentId: null, name: "見出し", resourceIds: [], dependencies: [] },
      task({ id: "A", parentId: "K", start: "2023-05-22" }),
    ]);
    const ml = computeLayout({ doc: messy, derived: deriveAll(messy, cwc), wc: cwc, zoom: "day", collapsed: new Set(), valueColumn: "duration" }, TODAY);
    expect(ml.rows.map((r) => r.taskId)).toEqual(["K", "A", UNCATEGORIZED_ROW_ID, "T"]);
    expect(ml.bars.map((b) => [b.taskId, b.rowIndex, b.y])).toEqual([["A", 1, 26 + 5], ["T", 3, 78 + 5]]);
  });
  it("担当者名とコメント件数: ユーザー未読み込みなら担当は空、不明な ID は「不明なユーザー」。サマリーのバーには出さない", () => {
    const d = mkDoc([
      task({ id: "P" }),
      task({ id: "c1", parentId: "P", start: "2023-05-22" }),
      task({ id: "L", start: "2023-05-23" }),
    ]);
    d.tasks[0]!.assigneeIds = ["U1"];
    d.tasks[2]!.assigneeIds = ["U1", "Ux", "U2"];
    const base = { doc: d, derived: deriveAll(d, cwc), wc: cwc, zoom: "day" as const, collapsed: new Set<string>(), valueColumn: "duration" as const };
    const none = computeLayout(base, TODAY);
    expect(none.rows.map((r) => r.assignees)).toEqual(["", "", ""]);
    const l = computeLayout({ ...base, users: new Map([["U1", "山田"], ["U2", "佐藤"]]), commentCounts: { l: 2 } }, TODAY);
    const byId = (id: string) => l.rows.find((r) => r.taskId === id)!;
    expect(byId("L").assignees).toBe("山田, 不明なユーザー, 佐藤");
    expect(byId("P").assignees).toBe("山田");
    expect(l.bars.find((b) => b.taskId === "L")!.assigneeText).toBe("山田, 不明なユーザー, 佐藤");
    expect(l.bars.find((b) => b.taskId === "P")!.assigneeText).toBe(""); // サマリーバー
    expect(byId("L").commentCount).toBe(2);
  });
  it("fitText: 収まれば無加工、超えたら省略記号で切る (全角は幅が広い)", () => {
    expect(fitText("abc", 98, 12)).toBe("abc");
    const cut = fitText("あいうえおかきくけこ", 98, 12);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThan(10);
    expect(fitText("a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q", 98, 12).endsWith("…")).toBe(true);
  });
  it("表示範囲は日付を持つタスクだけから決まる", () => {
    const r1 = computeRange(cderived, "day", TODAY);
    const only = mkDoc([task({ id: "A", start: "2023-05-22", end: "2023-05-23" }), task({ id: "B", start: "2023-05-24", end: "2023-05-25" }), task({ id: "T", start: "2023-05-29" })]);
    expect(r1).toEqual(computeRange(deriveAll(only, cwc), "day", TODAY));
  });
});

describe("computeLayout: マイルストーン・状態", () => {
  const wc0 = compileCalendar(mkDoc([]).project.calendar);
  const L = (d: GanttDocument, extra: Partial<Parameters<typeof computeLayout>[0]> = {}, today = TODAY) =>
    computeLayout({ doc: d, derived: deriveAll(d, wc0), wc: wc0, zoom: "day", collapsed: new Set(), valueColumn: "duration", ...extra }, today);

  it("ひし形は日付のマス (幅 1 日) に置かれ、行は 1 行。値の列には M/D。バーの種別は milestone", () => {
    const d = mkDoc([task({ id: "A", start: "2023-05-22", end: "2023-05-22" }), ms("M", "2023-05-27", null, "締切")]);
    const l = L(d);
    const bar = l.bars.find((b) => b.taskId === "M")!;
    expect(bar).toMatchObject({ kind: "milestone", rowIndex: 1, w: l.dayWidth, label: "締切", assigneeText: "" });
    expect(bar.x).toBe(xOfDate(l, "2023-05-27"));
    const row = l.rows.find((r) => r.taskId === "M")!;
    expect(row).toMatchObject({ isMilestone: true, valueText: "5/27", status: null, done: false, overdue: [], assignees: "" });
    expect(l.arrows).toEqual([]);
  });
  it("表示範囲にマイルストーンの日付も含まれる", () => {
    const d = mkDoc([task({ id: "A", start: "2023-05-22" }), ms("M", "2023-12-25")]);
    const r = computeRange(deriveAll(d, wc0), "day", TODAY);
    expect(r.end >= "2023-12-25").toBe(true);
  });
  it("カテゴリ・仮想行と混在しても、バーの行位置は行と 1:1 に対応する", () => {
    const d = mkDoc([
      mkCat("K"),
      ms("M1", "2023-05-23", "K"),
      task({ id: "A", parentId: "K", start: "2023-05-22" }),
      task({ id: "T", start: "2023-05-24" }),
      ms("M2", "2023-05-25"),
    ]);
    const l = L(d);
    expect(l.rows.map((r) => r.taskId)).toEqual(["K", "M1", "A", UNCATEGORIZED_ROW_ID, "T", "M2"]);
    expect(l.bars.map((b) => [b.taskId, b.rowIndex, b.kind])).toEqual([["M1", 1, "milestone"], ["A", 2, "leaf"], ["T", 4, "leaf"], ["M2", 5, "milestone"]]);
    for (const b of l.bars) expect(l.rows[b.rowIndex]!.taskId).toBe(b.taskId);
    expect(l.rows.map((r) => r.y)).toEqual([0, 26, 52, 78, 104, 130]);
  });
  it("状態: 完了は done、未着手の開始超過・未完了の終了超過は overdue。親は葉がすべて done のとき done (エラーは出さない)", () => {
    const d = mkDoc([
      task({ id: "P" }),
      task({ id: "a", parentId: "P", start: "2023-05-01", status: "done" }),
      task({ id: "b", parentId: "P", start: "2023-05-02", status: "done" }),
      task({ id: "T1", start: "2023-05-01" }),
      task({ id: "T2", start: "2023-05-30", status: "doing" }),
      task({ id: "T3", start: "2023-05-10", status: "doing" }),
    ]);
    const l = L(d, {}, "2023-05-22");
    const row = (id: string) => l.rows.find((r) => r.taskId === id)!;
    const bar = (id: string) => l.bars.find((b) => b.taskId === id)!;
    expect(row("a")).toMatchObject({ status: "done", done: true, overdue: [] });
    expect(row("P")).toMatchObject({ status: null, done: true, overdue: [] });
    expect(bar("P")).toMatchObject({ kind: "summary", done: true, overdue: false });
    expect(row("T1")).toMatchObject({ status: "todo", done: false, overdue: ["startPassed", "endPassed"] });
    expect(row("T2")).toMatchObject({ status: "doing", overdue: [] });
    expect(row("T3").overdue).toEqual(["endPassed"]);
    expect(bar("T1").overdue).toBe(true);
    expect(bar("a")).toMatchObject({ done: true, status: "done" });
    // 1 つでも未完了なら親は完了扱いにしない
    d.tasks.find((t) => t.id === "b")!.status = "doing";
    expect(L(d, {}, "2023-05-22").rows.find((r) => r.taskId === "P")!.done).toBe(false);
  });
  it("今日が開始日・終了日のタスクはエラーにしない", () => {
    const d = mkDoc([task({ id: "A", start: "2023-05-22", end: "2023-05-22" })]);
    expect(L(d, {}, "2023-05-22").rows[0]!.overdue).toEqual([]);
    expect(L(d, {}, "2023-05-23").rows[0]!.overdue).toEqual(["startPassed", "endPassed"]);
  });
});
