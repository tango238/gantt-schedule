// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cat, doc as mkDoc, ms, task } from "../../../shared/engine/__tests__/fixtures";
import type { GanttDocument } from "../../../shared/model/types";
import { ListPage } from "../../pages/ListPage";
import { useUsersStore } from "../../users/usersStore";
import { OverviewBoundary } from "../OverviewBoundary";
import { createLimiter, useOverviewDocs, type DocState } from "../useOverviewDocs";
import { loadSelection, loadView, SELECTION_KEY, VIEW_KEY } from "../storage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const docOf = (extra: string): GanttDocument =>
  mkDoc([
    cat("K", null, `カテゴリ${extra}`),
    ms("M", "2023-05-30", "K", `締切${extra}`),
    task({ id: "T", parentId: "K", start: "2023-05-22", end: "2023-05-24", name: `作業${extra}` }),
    task({ id: "D", parentId: "K", start: "2023-05-01", end: "2023-05-02", status: "done", name: `完了${extra}` }),
    task({ id: "U", start: "2023-05-25", name: `未分類${extra}` }),
  ]);

interface Mock {
  calls: Array<{ url: string; method: string }>;
  failIds: Set<string>;
  names: Record<string, string>;
}
function installFetch(ids: string[]): Mock {
  const m: Mock = { calls: [], failIds: new Set(), names: Object.fromEntries(ids.map((id, i) => [id, `S${i + 1}`])) };
  const ws = vi.fn();
  vi.stubGlobal("WebSocket", ws);
  m.calls.push = m.calls.push.bind(m.calls);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      m.calls.push({ url, method });
      const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
      if (url === "/api/schedules") {
        return json({ schedules: ids.map((id, i) => ({ id, name: m.names[id], updatedAt: 1700000000000 + i, updatedBy: { name: "u", email: "u@x" } })) });
      }
      if (url === "/api/users") return json({ users: [] });
      const mm = /^\/api\/schedules\/([^/]+)$/.exec(url);
      if (mm) {
        const id = decodeURIComponent(mm[1]!);
        if (m.failIds.has(id)) return json({ error: "boom" }, 500);
        return json({ id, name: m.names[id], rev: 3, doc: docOf(id) });
      }
      return json({}, 404);
    }),
  );
  return m;
}
const gets = (m: Mock) => m.calls.filter((c) => /^\/api\/schedules\/[^/]+$/.test(c.url));

beforeEach(() => {
  localStorage.clear();
  useUsersStore.setState({ users: [], names: new Map() });
});

/** 絞り込みの一覧を開き、チェックボックスを返す。 */
const openFilter = (name: string): HTMLInputElement[] => {
  if (!screen.queryByTestId(`overview-filter-${name}-menu`)) fireEvent.click(screen.getByTestId(`overview-filter-${name}`));
  return within(screen.getByTestId(`overview-filter-${name}-menu`)).queryAllByTestId("filter-option") as HTMLInputElement[];
};
const menuButton = (name: string, id: string) => within(screen.getByTestId(`overview-filter-${name}-menu`)).getByTestId(id);
const gridNames = () => screen.queryAllByTestId("grid-name").map((n) => n.textContent);

const renderList = async (ids: string[]) => {
  const m = installFetch(ids);
  render(<ListPage />);
  await waitFor(() => expect(screen.getAllByTestId("schedule-row")).toHaveLength(ids.length));
  return m;
};

describe("プロジェクトの絞り込みと全体スケジュールのペイン", () => {
  it("一覧にチェックボックスは無い。未選択なら見出しだけ出て、プロジェクトを選ぶと表示、外すと消える", async () => {
    const m = await renderList(["a", "b"]);
    expect(screen.getByTestId("list-page").querySelector('input[type="checkbox"]')).toBeNull();
    expect(screen.getByTestId("overview-hint")).toBeTruthy();
    expect(screen.queryByTestId("overview-scroll")).toBeNull();
    expect(gets(m)).toHaveLength(0);
    fireEvent.click(openFilter("project")[1]!);
    await waitFor(() => expect(screen.getAllByTestId("overview-project-name").map((n) => n.textContent)).toEqual(["S2"]));
    expect(gets(m).map((c) => c.url)).toEqual(["/api/schedules/b"]);
    expect(screen.getByTestId("overview-filter-project").textContent).toContain("プロジェクト (1)");
    fireEvent.click(openFilter("project")[1]!);
    expect(screen.queryByTestId("overview-scroll")).toBeNull();
    expect(screen.getByTestId("overview-hint")).toBeTruthy();
  });

  it("すべて選択・すべて外す。プロジェクトは一覧の並び、階層は プロジェクト > カテゴリ > マイルストーン > タスク", async () => {
    const m = await renderList(["a", "b"]);
    const boxes = openFilter("project");
    expect(boxes.map((b) => b.closest("label")!.textContent)).toEqual(["S1", "S2"]);
    fireEvent.click(boxes[1]!); // b を先に選んでも並びは一覧順
    fireEvent.click(openFilter("project")[0]!);
    await waitFor(() => expect(screen.getAllByTestId("overview-project-name")).toHaveLength(2));
    expect(openFilter("project").every((b) => b.checked)).toBe(true);
    const pane = screen.getByTestId("overview-pane");
    await waitFor(() => expect(within(pane).getAllByTestId("grid-name").length).toBeGreaterThan(8));
    const text = [...pane.querySelectorAll('[data-testid="overview-project-name"], [data-testid="grid-name"]')].map((n) => n.textContent);
    expect(text).toEqual([
      "S1", "カテゴリa", "締切a", "作業a", "完了a", "未分類a",
      "S2", "カテゴリb", "締切b", "作業b", "完了b", "未分類b",
    ]);
    // 同じタスク ID (K, M, T...) が 2 つのスケジュールにあっても両方出る
    expect(text.filter((x) => x === "締切a" || x === "締切b")).toHaveLength(2);
    expect(within(pane).getAllByTestId("milestone-diamond")).toHaveLength(2);
    expect(within(pane).getAllByTestId("uncategorized-row")).toHaveLength(2);
    // 完了は取消線、状態列
    expect(within(pane).getAllByTestId("grid-name").find((n) => n.textContent === "完了a")!.getAttribute("text-decoration")).toBe("line-through");
    expect(within(pane).getAllByTestId("overdue-mark").length).toBeGreaterThan(0);
    fireEvent.click(menuButton("project", "filter-clear"));
    expect(screen.queryByTestId("overview-scroll")).toBeNull();
    expect(loadSelection()).toEqual([]);
    fireEvent.click(menuButton("project", "filter-select-all"));
    await waitFor(() => expect(screen.getAllByTestId("overview-project-name")).toHaveLength(2));
    expect(loadSelection()).toEqual(["a", "b"]);
    expect(m.calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("一覧は Escape・外側のクリックで閉じる", async () => {
    await renderList(["a"]);
    openFilter("project");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("overview-filter-project-menu")).toBeNull();
    openFilter("project");
    fireEvent.pointerDown(screen.getByTestId("list-page"));
    expect(screen.queryByTestId("overview-filter-project-menu")).toBeNull();
  });

  it("チェック状態は localStorage に保存され、リロード (再マウント) で復元。存在しない ID は捨てる", async () => {
    localStorage.setItem(SELECTION_KEY, JSON.stringify({ ids: ["b", "gone"] }));
    const m = await renderList(["a", "b"]);
    await waitFor(() => expect(screen.getAllByTestId("overview-project-name").map((n) => n.textContent)).toEqual(["S2"]));
    expect(openFilter("project").map((b) => b.checked)).toEqual([false, true]);
    expect(loadSelection()).toEqual(["b"]);
    expect(gets(m).map((c) => c.url)).toEqual(["/api/schedules/b"]);
  });

  it("取得に失敗したスケジュールは見出し行にエラー、他は表示。更新で取り直す", async () => {
    localStorage.setItem(SELECTION_KEY, JSON.stringify({ ids: ["a", "b"] }));
    const m = installFetch(["a", "b"]);
    m.failIds.add("a");
    render(<ListPage />);
    const note = await screen.findByTestId("overview-project-note");
    expect(note.textContent).toBe("読み込めませんでした");
    await waitFor(() => expect(screen.getAllByTestId("overview-project-name")).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByTestId("grid-name").some((n) => n.textContent === "作業b")).toBe(true));
    expect(screen.queryAllByTestId("grid-name").some((n) => n.textContent === "作業a")).toBe(false);
    m.failIds.clear();
    const before = gets(m).length;
    await waitFor(() => expect((screen.getByTestId("overview-refresh") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("overview-refresh"));
    await waitFor(() => expect(screen.getAllByTestId("grid-name").some((n) => n.textContent === "作業a")).toBe(true));
    expect(gets(m).length - before).toBe(2);
    expect(screen.queryByTestId("overview-project-note")).toBeNull();
    expect(screen.getByTestId("overview-fetched").textContent).toMatch(/^取得: \d\d:\d\d:\d\d$/);
  });

  it("折りたたみ (プロジェクト・カテゴリ) とズームが保存される", async () => {
    localStorage.setItem(SELECTION_KEY, JSON.stringify({ ids: ["a", "b"] }));
    installFetch(["a", "b"]);
    render(<ListPage />);
    await waitFor(() => expect(screen.getAllByTestId("grid-name").some((n) => n.textContent === "作業b")).toBe(true));
    const pane = screen.getByTestId("overview-pane");
    const rowOf = (name: string) => pane.querySelector(`[data-testid="overview-project-row"][data-row-id="${name}"]`) as HTMLElement;
    fireEvent.click(within(rowOf("a")).getByTestId("toggle-collapse"));
    await waitFor(() => expect(within(pane).queryAllByTestId("grid-name").some((n) => n.textContent === "作業a")).toBe(false));
    expect(within(pane).queryAllByTestId("grid-name").some((n) => n.textContent === "作業b")).toBe(true);
    expect(loadView().collapsed).toEqual(["a"]);
    // カテゴリ K (スケジュール b) を畳む
    const kRow = within(pane).getAllByTestId("grid-name").find((n) => n.textContent === "カテゴリb")!.closest("[data-row-id]")!;
    fireEvent.click(within(kRow as HTMLElement).getByTestId("toggle-collapse"));
    await waitFor(() => expect(within(pane).queryAllByTestId("grid-name").some((n) => n.textContent === "作業b")).toBe(false));
    expect(loadView().collapsed).toEqual(["a", "b:k"]);
    fireEvent.click(within(pane).getByRole("button", { name: "月" }));
    expect(loadView().zoom).toBe("month");
    cleanup();
    installFetch(["a", "b"]);
    render(<ListPage />);
    await waitFor(() => expect(screen.getAllByTestId("overview-project-name")).toHaveLength(2));
    expect(within(screen.getByTestId("overview-pane")).queryAllByTestId("grid-name").some((n) => n.textContent === "作業a")).toBe(false);
    expect(within(screen.getByTestId("overview-pane")).getByRole("button", { name: "月" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("高さのキー操作で変わり、localStorage に保存される", async () => {
    localStorage.setItem(SELECTION_KEY, JSON.stringify({ ids: ["a"] }));
    installFetch(["a"]);
    render(<ListPage />);
    const handle = await screen.findByTestId("overview-resize");
    const h0 = Number(handle.getAttribute("aria-valuenow"));
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(Number(screen.getByTestId("overview-resize").getAttribute("aria-valuenow"))).toBe(h0 + 24);
    expect(loadView().height).toBe(h0 + 24);
  });

  it("読み取り専用: ダブルクリック・ドラッグ・クリックをしても編集 UI は出ず、書き込みの通信も WebSocket も無い", async () => {
    localStorage.setItem(SELECTION_KEY, JSON.stringify({ ids: ["a"] }));
    const m = installFetch(["a"]);
    render(<ListPage />);
    await waitFor(() => expect(screen.getAllByTestId("grid-name").some((n) => n.textContent === "作業a")).toBe(true));
    const pane = screen.getByTestId("overview-pane");
    const name = within(pane).getAllByTestId("grid-name").find((n) => n.textContent === "作業a")!;
    fireEvent.click(name);
    fireEvent.click(name);
    fireEvent.doubleClick(name);
    const bar = pane.querySelector('[data-task-id="a:T"]')!;
    expect(bar).toBeTruthy();
    const tl = pane.querySelector(".timeline-body")!;
    fireEvent.pointerDown(bar, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerMove(tl, { clientX: 200, clientY: 10 });
    fireEvent.pointerUp(tl);
    fireEvent.doubleClick(bar);
    fireEvent.keyDown(pane, { key: "Delete" });
    fireEvent.keyDown(pane, { key: "Enter" });
    expect(pane.querySelector(".inline-editor, input, textarea")).toBeNull();
    expect(pane.querySelector("[data-link-handle]")).toBeNull();
    expect(pane.querySelector('[data-testid="peer-selection"]')).toBeNull();
    expect(m.calls.every((c) => c.method === "GET")).toBe(true);
    expect(WebSocket).not.toHaveBeenCalled();
    expect(gets(m)).toHaveLength(1);
  });

  it("コメント件数の印は出さない", async () => {
    localStorage.setItem(SELECTION_KEY, JSON.stringify({ ids: ["a"] }));
    installFetch(["a"]);
    render(<ListPage />);
    await waitFor(() => expect(screen.getAllByTestId("grid-name").length).toBeGreaterThan(3));
    expect(screen.queryByTestId("comment-badge")).toBeNull();
    expect(VIEW_KEY).toBeTruthy();
  });
});

describe("取得の同時数と取り消し", () => {
  it("limiter: 同時に動くのは上限まで。待ち行列の中で中断したものは実行しない", async () => {
    const limit = createLimiter(4);
    let active = 0;
    let peak = 0;
    let started = 0;
    const resolvers: Array<() => void> = [];
    const ctrls = Array.from({ length: 10 }, () => new AbortController());
    const jobs = ctrls.map((c) =>
      limit(
        () =>
          new Promise<void>((resolve) => {
            started++;
            active++;
            peak = Math.max(peak, active);
            resolvers.push(() => {
              active--;
              resolve();
            });
          }),
        c.signal,
      ).catch((e) => e),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(peak).toBe(4);
    for (let i = 4; i < 8; i++) ctrls[i]!.abort();
    while (resolvers.length > 0) {
      resolvers.shift()!();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    const out = await Promise.all(jobs);
    expect(peak).toBe(4);
    expect(started).toBe(6);
    expect(out.filter((x) => x instanceof Error)).toHaveLength(4);
  });
});

describe("壊れた doc・取り消し・順序", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);
  /** 取得が resolve されるまで止まる fetch。signal の中断で reject する。 */
  function installHangingFetch(ids: string[]) {
    const st = { started: [] as string[], active: 0, peak: 0, release: [] as Array<() => void> };
    vi.stubGlobal("WebSocket", vi.fn());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
        if (url === "/api/schedules") return json({ schedules: ids.map((id, i) => ({ id, name: id, updatedAt: i, updatedBy: { name: "u", email: "u@x" } })) });
        if (url === "/api/users") return json({ users: [] });
        const id = decodeURIComponent(/\/([^/]+)$/.exec(url)![1]!);
        st.started.push(id);
        st.active++;
        st.peak = Math.max(st.peak, st.active);
        return new Promise<Response>((resolve, reject) => {
          const done = () => {
            st.active--;
          };
          init?.signal?.addEventListener("abort", () => {
            done();
            reject(new DOMException("aborted", "AbortError"));
          });
          st.release.push(() => {
            done();
            resolve(json({ id, name: id, rev: 1, doc: docOf(id) }));
          });
        });
      }),
    );
    return st;
  }

  it("50 件選択 -> 全解除で、取得は同時 4 件のまま止まる (残りは出さない)", async () => {
    const ids = many(50);
    const st = installHangingFetch(ids);
    render(<ListPage />);
    await waitFor(() => expect(screen.getAllByTestId("schedule-row")).toHaveLength(50));
    openFilter("project");
    fireEvent.click(menuButton("project", "filter-select-all"));
    await waitFor(() => expect(st.started.length).toBe(4));
    fireEvent.click(menuButton("project", "filter-clear"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(st.started.length).toBe(4);
    expect(st.peak).toBe(4);
    expect(screen.queryByTestId("overview-scroll")).toBeNull();
  });

  it("全解除 -> 全選択を繰り返しても同時 4 を超えない", async () => {
    const ids = many(20);
    const st = installHangingFetch(ids);
    render(<ListPage />);
    await waitFor(() => expect(screen.getAllByTestId("schedule-row")).toHaveLength(20));
    openFilter("project");
    for (let i = 0; i < 3; i++) {
      fireEvent.click(menuButton("project", "filter-select-all"));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      fireEvent.click(menuButton("project", "filter-clear"));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    expect(st.peak).toBeLessThanOrEqual(4);
  });

  it("外して付け直したとき、古い応答が新しい応答を上書きしない (世代番号)", async () => {
    const calls: Array<{ resolve: (s: DocState) => void }> = [];
    const fetcher = (_id: string, _signal: AbortSignal) => new Promise<DocState>((resolve) => calls.push({ resolve }));
    const { result, rerender } = renderHook(({ ids }: { ids: string[] }) => useOverviewDocs(ids, fetcher, createLimiter(4)), { initialProps: { ids: ["a"] } });
    await waitFor(() => expect(calls).toHaveLength(1));
    rerender({ ids: [] });
    rerender({ ids: ["a"] });
    await waitFor(() => expect(calls).toHaveLength(2));
    const okDoc = (name: string): DocState => ({ status: "ok", doc: docOf("x"), name });
    await act(async () => {
      calls[1]!.resolve(okDoc("新"));
      await Promise.resolve();
    });
    await act(async () => {
      calls[0]!.resolve(okDoc("古"));
      await Promise.resolve();
    });
    const st = result.current.docs.get("a");
    expect(st?.status === "ok" && st.name).toBe("新");
  });

  const broken: Record<string, unknown> = {
    nulltask: { version: 1, project: { name: "x" }, resources: [], colorLabels: [], tasks: [null] },
    assignee: { version: 1, project: { name: "x" }, resources: [], colorLabels: [], tasks: [{ id: "a", name: "a", start: "2023-05-22", end: "2023-05-22", assigneeIds: 5, resourceIds: [], dependencies: [] }] },
    objname: { version: 1, project: { name: "x" }, resources: [], colorLabels: [], tasks: [{ id: "a", name: { x: 1 }, start: "2023-05-22", end: "2023-05-22", resourceIds: [], dependencies: [] }] },
  };
  it.each(Object.keys(broken))("壊れた doc (%s) が 1 件あっても、一覧は残り他のスケジュールは表示される", async (k) => {
    localStorage.setItem(SELECTION_KEY, JSON.stringify({ ids: ["bad", "good"] }));
    vi.stubGlobal("WebSocket", vi.fn());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
        if (url === "/api/schedules") return json({ schedules: ["bad", "good"].map((id, i) => ({ id, name: id, updatedAt: i, updatedBy: { name: "u", email: "u@x" } })) });
        if (url === "/api/users") return json({ users: [] });
        if (url.endsWith("/bad")) return json({ id: "bad", name: "bad", rev: 1, doc: broken[k] });
        return json({ id: "good", name: "good", rev: 1, doc: docOf("good") });
      }),
    );
    render(<ListPage />);
    await waitFor(() => expect(screen.getAllByTestId("grid-name").some((n) => n.textContent === "作業good")).toBe(true));
    expect(screen.getByTestId("list-page")).toBeTruthy();
    expect(screen.getByTestId("overview-project-note").textContent).toBe("表示できませんでした");
    expect(screen.queryByTestId("overview-error")).toBeNull();
  });

  it("描画中に例外が出ても一覧は残り、「プロジェクトの選択をすべて外す」で消せる", () => {
    const onClear = vi.fn();
    const Boom = () => {
      throw new Error("boom");
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <OverviewBoundary resetKey="a" onClearAll={onClear}>
        <Boom />
      </OverviewBoundary>,
    );
    spy.mockRestore();
    expect(screen.getByTestId("overview-error").textContent).toContain("全体スケジュールを表示できません");
    fireEvent.click(screen.getByTestId("overview-clear"));
    expect(onClear).toHaveBeenCalled();
  });

  it("一覧が取れたとき、存在しないスケジュールの折りたたみも捨てる", async () => {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ zoom: "week", valueColumn: "duration", height: 280, collapsed: ["a:k", "gone", "gone:x"] }));
    installFetch(["a"]);
    render(<ListPage />);
    await waitFor(() => expect(loadView().collapsed).toEqual(["a:k"]));
  });
});

describe("担当者・状況の絞り込み", () => {
  const filterDoc = (): GanttDocument =>
    mkDoc([
      cat("K", null, "カテゴリ"),
      ms("M", "2023-05-30", "K", "締切"),
      { ...task({ id: "A", parentId: "K", start: "2023-05-22", name: "Aの未着手" }), assigneeIds: ["u1"] },
      { ...task({ id: "B", parentId: "K", start: "2023-05-23", name: "Bの進行中", status: "doing" }), assigneeIds: ["u2"] },
      cat("E", null, "空になるカテゴリ"),
      task({ id: "C", parentId: "E", start: "2023-05-24", name: "担当なしの完了", status: "done" }),
      { ...task({ id: "D", start: "2023-05-25", name: "ABの完了", status: "done" }), assigneeIds: ["u1", "u2"] },
    ]);
  const setup = async (wait = true) => {
    localStorage.setItem(SELECTION_KEY, JSON.stringify({ ids: ["a", "b"] }));
    vi.stubGlobal("WebSocket", vi.fn());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
        if (url === "/api/schedules") return json({ schedules: ["a", "b"].map((id, i) => ({ id, name: id, updatedAt: i, updatedBy: { name: "u", email: "u@x" } })) });
        if (url === "/api/users") return json({ users: [{ id: "u1", name: "佐藤", email: "s@x" }, { id: "u2", name: "鈴木", email: "z@x" }] });
        // b は担当なし・未着手のタスクだけ
        if (url.endsWith("/b")) return json({ id: "b", name: "b", rev: 1, doc: mkDoc([task({ id: "X", start: "2023-05-22", name: "bの作業" })]) });
        return json({ id: "a", name: "a", rev: 1, doc: filterDoc() });
      }),
    );
    useUsersStore.setState({ users: [], names: new Map([["u1", "佐藤"], ["u2", "鈴木"]]) });
    render(<ListPage />);
    if (wait) await waitFor(() => expect(gridNames()).toContain("bの作業"));
  };
  const pick = (name: string, label: string) => fireEvent.click(openFilter(name).find((b) => b.closest("label")!.textContent === label)!);
  const projects = () => screen.queryAllByTestId("overview-project-name").map((n) => n.textContent);

  it("未選択なら絞り込まない。担当者で絞ると、合うタスクとその親・同じ階層のマイルストーンだけ残る", async () => {
    await setup();
    expect(gridNames()).toEqual(["カテゴリ", "締切", "Aの未着手", "Bの進行中", "空になるカテゴリ", "担当なしの完了", "ABの完了", "bの作業"]);
    expect(openFilter("assignee").map((b) => b.closest("label")!.textContent)).toEqual(["担当なし", "佐藤", "鈴木"]);
    pick("assignee", "佐藤");
    expect(gridNames()).toEqual(["カテゴリ", "締切", "Aの未着手", "ABの完了"]);
    expect(projects()).toEqual(["a"]); // 合うタスクが無いプロジェクトは出さない
    expect(screen.getByTestId("overview-filter-assignee").textContent).toContain("担当者 (1)");
    expect(loadView().assignees).toEqual(["u1"]);
    // 複数選択は OR
    pick("assignee", "担当なし");
    expect(gridNames()).toEqual(["カテゴリ", "締切", "Aの未着手", "空になるカテゴリ", "担当なしの完了", "ABの完了", "bの作業"]);
    expect(projects()).toEqual(["a", "b"]);
  });

  it("状況で絞る。担当者と状況は AND。合うものが無ければその旨を出す", async () => {
    await setup();
    pick("status", "完了");
    expect(gridNames()).toEqual(["空になるカテゴリ", "担当なしの完了", "ABの完了"]);
    expect(loadView().statuses).toEqual(["done"]);
    pick("status", "進行中");
    expect(gridNames()).toEqual(["カテゴリ", "締切", "Bの進行中", "空になるカテゴリ", "担当なしの完了", "ABの完了"]);
    pick("assignee", "鈴木");
    expect(gridNames()).toEqual(["カテゴリ", "締切", "Bの進行中", "ABの完了"]);
    fireEvent.click(menuButton("status", "filter-clear"));
    pick("status", "未着手");
    expect(gridNames()).toEqual([]);
    expect(projects()).toEqual([]);
    expect(screen.getByTestId("overview-nomatch").textContent).toBe("条件に合うタスクはありません");
    fireEvent.click(menuButton("assignee", "filter-clear"));
    expect(gridNames()).toEqual(["カテゴリ", "締切", "Aの未着手", "bの作業"]);
    expect(screen.queryByTestId("overview-nomatch")).toBeNull();
  });

  it("絞り込みは保存され、再マウントで復元される", async () => {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ zoom: "week", valueColumn: "duration", height: 280, collapsed: [], assignees: ["u2"], statuses: ["doing", "bogus"] }));
    await setup(false); // 絞り込み済みなので「bの作業」は出ない
    await waitFor(() => expect(gridNames()).toEqual(["カテゴリ", "締切", "Bの進行中"]));
    expect(loadView().statuses).toEqual(["doing"]);
  });
});
