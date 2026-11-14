// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileCalendar, deriveAll } from "../../../shared/engine";
import { cat, doc as mkDoc, ms, seq, task } from "../../../shared/engine/__tests__/fixtures";
import type { GanttDocument } from "../../../shared/model/types";
import { setCommandContextOverride, useAppStore } from "../../store/appStore";
import { loadUsers, refreshIfUnknown, USERS_REFRESH_MS, useUsersStore } from "../../users/usersStore";
import { Bars } from "../chart/Bars";
import { GridBody } from "../chart/GridBody";
import { computeLayout } from "../chart/layout";
import { mapKey } from "../keymap";
import { selectionCaps } from "../actions";
import { StatusField } from "../SidePanel/StatusField";
import { useToday } from "../../useToday";
import { TasksTab } from "../SidePanel/TasksTab";

afterEach(cleanup);

const wc = compileCalendar({ weekends: [0, 6], holidays: [] });
const mk = (): GanttDocument =>
  mkDoc([
    cat("K"),
    ms("M", "2023-05-27", "K", "締切"),
    task({ id: "A", parentId: "K", start: "2023-05-01", end: "2023-05-02" }), // 未着手・過去 (両方エラー)
    task({ id: "D", parentId: "K", start: "2023-05-01", end: "2023-05-02", status: "done" }),
    task({ id: "T", start: "2023-05-24" }),
  ]);

beforeEach(() => {
  setCommandContextOverride({ today: "2023-05-22", newId: seq("N"), defaultTaskName: "n", defaultCategoryName: "c", defaultMilestoneName: "m" });
  useAppStore.setState({ readOnly: false, viewing: null, selectedId: null });
  useAppStore.getState().applySnapshot({ id: "S1", rev: 0, doc: mk() });
  useUsersStore.setState({ users: [], names: new Map() });
});

const layoutOf = (d: GanttDocument, today = "2023-05-22") =>
  computeLayout({ doc: d, derived: deriveAll(d, wc), wc, zoom: "day", collapsed: new Set(), valueColumn: "duration" }, today);

describe("グリッド・バーの表示", () => {
  const renderGrid = (today = "2023-05-22") => {
    const l = layoutOf(mk(), today);
    return render(
      <svg>
        <GridBody rows={l.rows} bodyHeight={l.bodyHeight} selectedId={null} onSelect={() => {}} onToggle={() => {}} />
        <Bars bars={l.bars} selectedId={null} onSelect={() => {}} linkHandles />
      </svg>,
    );
  };
  it("完了の行は取消線 + グレー、エラーの行は赤い印 (aria-label に理由)、状態の列に未着手/完了", () => {
    renderGrid();
    const names = screen.getAllByTestId("grid-name");
    const doneName = names.find((n) => n.textContent === "D")!;
    expect(doneName.getAttribute("text-decoration")).toBe("line-through");
    expect(doneName.getAttribute("fill")).toBe("#9CA3AF");
    expect(names.find((n) => n.textContent === "A")!.getAttribute("text-decoration")).toBeNull();
    const marks = screen.getAllByTestId("overdue-mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.getAttribute("aria-label")).toBe("開始日を過ぎています / 終了日を過ぎています");
    expect(screen.getAllByTestId("grid-status").map((g) => g.getAttribute("data-status"))).toEqual(["todo", "done", "todo"]);
  });
  it("バー: エラーは赤枠、完了はグレー (data-done)、マイルストーンはひし形 + 名前でリサイズ・リンクのつまみなし", () => {
    const { container } = renderGrid();
    expect(screen.getAllByTestId("bar-overdue")).toHaveLength(1);
    expect(container.querySelector('g[data-task-id="D"]')!.hasAttribute("data-done")).toBe(true);
    expect(container.querySelector('g[data-task-id="A"]')!.hasAttribute("data-done")).toBe(false);
    const m = container.querySelector('g[data-task-id="M"]')!;
    expect(m.getAttribute("data-kind")).toBe("milestone");
    expect(m.querySelector('[data-testid="milestone-diamond"]')).not.toBeNull();
    expect(m.querySelector("[data-link-handle]")).toBeNull();
    expect(screen.getByTestId("milestone-label").textContent).toBe("締切");
    expect(container.querySelector('g[data-task-id="A"] [data-link-handle]')).not.toBeNull();
  });
  it("進捗 (%) はどこにも出ない", () => {
    const { container } = renderGrid();
    expect(container.textContent).not.toMatch(/\d+%/);
  });
  it("今日が期限のタスクにはエラーの印が出ない", () => {
    renderGrid("2023-05-01");
    expect(screen.queryAllByTestId("overdue-mark")).toHaveLength(0);
    expect(screen.queryAllByTestId("bar-overdue")).toHaveLength(0);
  });
  it("グリッドのマイルストーン行: ひし形の印と日付 (M/D)", () => {
    renderGrid();
    expect(screen.getAllByTestId("grid-milestone-mark")).toHaveLength(1);
  });
});

describe("右ペイン", () => {
  it("StatusField: 状態を変更でき、期限超過は当てはまる理由をすべて出す", () => {
    const d = useAppStore.getState().doc!;
    const t = d.tasks.find((x) => x.id === "A")!;
    render(<StatusField task={t} start="2023-05-01" end="2023-05-02" today="2023-05-22" />);
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "未着手のまま開始日を過ぎています",
      "完了していないまま終了日を過ぎています",
    ]);
    fireEvent.click(screen.getByTestId("panel-status-doing"));
    expect(useAppStore.getState().doc!.tasks.find((x) => x.id === "A")!.status).toBe("doing");
  });
  it("StatusField: 完了ならエラーは出ない", () => {
    const t = mk().tasks.find((x) => x.id === "D")!;
    render(<StatusField task={t} start="2023-05-01" end="2023-05-02" today="2023-05-22" />);
    expect(screen.queryByTestId("panel-overdue")).toBeNull();
  });
  it("タスク: 状態の欄があり、進捗の欄は無い。親タスクには状態の欄を出さない", () => {
    useAppStore.setState({ selectedId: "A" });
    const { unmount } = render(<TasksTab />);
    expect(screen.getByTestId("panel-status-field")).toBeTruthy();
    expect(screen.queryByTestId("panel-progress")).toBeNull();
    expect(document.body.textContent).not.toContain("進捗");
    unmount();
    const d = useAppStore.getState().doc!;
    useAppStore.getState().applySnapshot({ id: "S1", rev: 0, doc: { ...d, tasks: [...d.tasks, task({ id: "A1", parentId: "A", start: "2023-05-01" })] } });
    useAppStore.setState({ selectedId: "A" });
    render(<TasksTab />);
    expect(screen.queryByTestId("panel-status-field")).toBeNull();
  });
  it("マイルストーン: 名前・日付 (1 つ)・カテゴリ・色ラベル・詳細・コメントだけ。日付を変えられる", () => {
    useAppStore.setState({ selectedId: "M" });
    render(<TasksTab />);
    const panel = screen.getByTestId("panel-milestone");
    expect(panel).toBeTruthy();
    for (const absent of ["panel-status-field", "panel-assignees", "panel-hours", "panel-duration", "panel-start", "panel-end"]) {
      expect(screen.queryByTestId(absent)).toBeNull();
    }
    expect(screen.queryByText("リソース")).toBeNull();
    expect(screen.getByTestId("panel-name")).toBeTruthy();
    expect(screen.getByTestId("panel-category-select")).toBeTruthy();
    expect(screen.getByTestId("panel-notes")).toBeTruthy();
    expect(screen.getByTestId("comments")).toBeTruthy();
    const date = screen.getByTestId("panel-milestone-date") as HTMLInputElement;
    expect(date.value).toBe("2023-05-27");
    fireEvent.change(date, { target: { value: "2023-06-15" } });
    const m = useAppStore.getState().doc!.tasks.find((x) => x.id === "M")!;
    expect([m.start, m.end]).toEqual(["2023-06-15", "2023-06-15"]);
  });
});

describe("ツールバー・キー操作", () => {
  const key = (k: string, extra: Partial<Parameters<typeof mapKey>[0]> = {}) =>
    mapKey({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, keyCode: 0, ...extra }, { platform: "mac", editing: false, dragging: false, modalOpen: false });
  it("Alt+Enter でマイルストーンを追加 (Enter / Shift+Enter は従来どおり)", () => {
    expect(key("Enter", { altKey: true })).toEqual({ type: "addMilestone" });
    expect(key("Enter")).toEqual({ type: "addTask" });
    expect(key("Enter", { shiftKey: true })).toEqual({ type: "addCategory" });
  });
  it("インデント可否: マイルストーンの下には置けず、マイルストーンはカテゴリの直後でだけインデントできる", () => {
    const d = mkDoc([cat("K"), ms("M", "2023-05-22"), task({ id: "A", start: "2023-05-22" }), ms("M2", "2023-05-23")]);
    expect(selectionCaps(d, "M").canIndent).toBe(true); // 直前がカテゴリ
    expect(selectionCaps(d, "A").canIndent).toBe(false); // 直前がマイルストーン
    expect(selectionCaps(d, "M2").canIndent).toBe(false); // 直前がタスク
  });
});

describe("ユーザー一覧の再取得 (担当 ID が一覧に無いとき)", () => {
  const users = [{ id: "u9", name: "新人", email: "n@example.com" }];
  const stub = () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ users }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  afterEach(() => vi.unstubAllGlobals());

  it("新しく現れた未知の ID は取り直し、見つかれば表示できる。取得は間隔制限を守る", async () => {
    const fetchMock = stub();
    useUsersStore.setState({ users: null, names: null });
    await loadUsers(true, 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await refreshIfUnknown(["u9"])).toBe("none"); // 既知
    useUsersStore.setState({ users: [], names: new Map() });
    expect(await refreshIfUnknown(["u9"], Date.now())).toBe("throttled"); // 取得直後: 間隔内
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await refreshIfUnknown(["u9"], Date.now() + USERS_REFRESH_MS + 1)).toBe("fetched");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useUsersStore.getState().names?.get("u9")).toBe("新人");
  });
  it("取り直しても見つからない ID が残っても、取得は増え続けない (同じ集合では二度と取りに行かない)", async () => {
    const fetchMock = stub();
    await loadUsers(true, 1000);
    const base = Date.now() + 10 * USERS_REFRESH_MS;
    expect(await refreshIfUnknown(["ghost"], base)).toBe("fetched");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 一覧 (names) が更新されて effect が何度再実行されても、時間が経っても、同じ ID の集合では取りに行かない
    for (let i = 1; i <= 5; i++) expect(await refreshIfUnknown(["ghost"], base + i * USERS_REFRESH_MS)).toBe("none");
    expect(await refreshIfUnknown(["ghost", "u9"], base + 9 * USERS_REFRESH_MS)).toBe("none");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 新しい未知の ID が現れたときだけ、間隔制限つきで 1 回
    expect(await refreshIfUnknown(["ghost", "ghost2"], base + 10 * USERS_REFRESH_MS)).toBe("fetched");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await refreshIfUnknown(["ghost", "ghost2"], base + 20 * USERS_REFRESH_MS)).toBe("none");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("スケジュールを開き直す (強制取得) と、見つからなかった ID の記録は消える", async () => {
    const fetchMock = stub();
    await loadUsers(true, 1000);
    const base = Date.now() + 10 * USERS_REFRESH_MS;
    await refreshIfUnknown(["ghost"], base);
    expect(await refreshIfUnknown(["ghost"], base)).toBe("none");
    await loadUsers(true);
    expect(await refreshIfUnknown(["ghost"], Date.now() + USERS_REFRESH_MS + 1)).toBe("fetched");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("useToday: 「今日」の更新は 1 か所", () => {
  it("複数のコンポーネントが同じ値を使い、日付が変わると 1 分以内に全員が更新される。タイマーは 1 本", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 10, 12, 23, 59, 30));
      const spy = vi.spyOn(globalThis, "setInterval");
      const A = () => <i data-testid="a">{useToday()}</i>;
      const B = () => <i data-testid="b">{useToday()}</i>;
      render(<><A /><B /></>);
      expect(screen.getByTestId("a").textContent).toBe("2026-11-12");
      expect(spy.mock.calls.filter((c) => c[1] === 60_000)).toHaveLength(1);
      await act(async () => {
        vi.setSystemTime(new Date(2026, 10, 13, 0, 0, 10));
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByTestId("a").textContent).toBe("2026-11-13");
      expect(screen.getByTestId("b").textContent).toBe("2026-11-13");
      spy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
