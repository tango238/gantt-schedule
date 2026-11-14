// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cat, doc as mkDoc, task } from "../../../shared/engine/__tests__/fixtures";
import { Toast } from "../../components/Toast";
import { useUiStore } from "../../components/uiStore";
import { ListPage } from "../../pages/ListPage";
import { noteFavorite, toggleFavoriteOf, useFavoriteStore } from "../favoriteStore";
import { orderFavoritesFirst } from "../order";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  localStorage.clear();
  useUiStore.setState({ toasts: [], confirm: null });
  useFavoriteStore.setState({ byId: {}, inflight: {} });
});

describe("orderFavoritesFirst", () => {
  it("お気に入りを上に。それぞれの中では元の順を保つ", () => {
    const l = [
      { id: "a", favorite: false },
      { id: "b", favorite: true },
      { id: "c", favorite: false },
      { id: "d", favorite: true },
    ];
    expect(orderFavoritesFirst(l).map((x) => x.id)).toEqual(["b", "d", "a", "c"]);
    expect(orderFavoritesFirst([]).length).toBe(0);
  });
});

interface Srv {
  fav: Record<string, boolean>;
  calls: Array<{ url: string; method: string }>;
  failFavorite: boolean;
  holdFavorite: Promise<void> | null;
  /** 呼び出し順 (0 始まり) ごとの遅延。1 回目だけ遅らせるなど。 */
  gates: Array<Promise<void> | undefined>;
  favCalls: number;
}
function install(ids: string[], fav: Record<string, boolean> = {}): Srv {
  const s: Srv = { fav: { ...fav }, calls: [], failFavorite: false, holdFavorite: null, gates: [], favCalls: 0 };
  vi.stubGlobal("WebSocket", vi.fn());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      s.calls.push({ url, method });
      const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
      if (url === "/api/schedules") {
        return json({
          schedules: ids.map((id, i) => ({ id, name: `S${id}`, updatedAt: 1700000000000 - i, updatedBy: { name: "u", email: "u@x" }, favorite: s.fav[id] === true })),
        });
      }
      if (url === "/api/users") return json({ users: [] });
      const fm = /^\/api\/schedules\/([^/]+)\/favorite$/.exec(url);
      if (fm) {
        const gate = s.gates[s.favCalls++];
        if (gate) await gate;
        if (s.holdFavorite) await s.holdFavorite;
        if (s.failFavorite) return json({ error: "boom" }, 500);
        s.fav[fm[1]!] = method === "PUT";
        return json({ favorite: method === "PUT" });
      }
      const mm = /^\/api\/schedules\/([^/]+)$/.exec(url);
      if (mm) {
        const id = mm[1]!;
        return json({
          id,
          name: `S${id}`,
          rev: 1,
          favorite: s.fav[id] === true,
          doc: mkDoc([cat("K", null, `K${id}`), task({ id: "T", parentId: "K", start: "2023-05-22", end: "2023-05-24", name: "t" })]),
        });
      }
      return json({}, 404);
    }),
  );
  return s;
}
const names = () => screen.getAllByTestId("schedule-row").map((r) => within(r).getAllByRole("link")[0]!.textContent);
const stars = () => screen.getAllByTestId("favorite-toggle");
const renderList = async (ids: string[], fav: Record<string, boolean> = {}) => {
  const s = install(ids, fav);
  render(
    <>
      <ListPage />
      <Toast />
    </>,
  );
  await waitFor(() => expect(screen.getAllByTestId("schedule-row")).toHaveLength(ids.length));
  return s;
};

describe("一覧の星", () => {
  it("お気に入りが 0 件なら見出しは出ず従来の並び。星は aria-pressed=false で名前入りの aria-label", async () => {
    await renderList(["a", "b", "c"]);
    expect(names()).toEqual(["Sa", "Sb", "Sc"]);
    expect(screen.queryByTestId("group-favorites")).toBeNull();
    expect(screen.queryByTestId("group-all")).toBeNull();
    expect(stars()[1]!.getAttribute("aria-pressed")).toBe("false");
    expect(stars()[1]!.getAttribute("aria-label")).toContain("Sb");
  });

  it("お気に入りは上に固定され、見出しが出る。それぞれの中は元の順", async () => {
    await renderList(["a", "b", "c", "d"], { b: true, d: true });
    expect(names()).toEqual(["Sb", "Sd", "Sa", "Sc"]);
    const rows = [...document.querySelectorAll("tbody tr")].map((r) => r.getAttribute("data-testid"));
    expect(rows).toEqual(["group-favorites", "schedule-row", "schedule-row", "group-all", "schedule-row", "schedule-row"]);
    expect(stars().map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "true", "false", "false"]);
  });

  it("全部お気に入りなら「すべて」の見出しは出ない", async () => {
    await renderList(["a", "b"], { a: true, b: true });
    expect(screen.getByTestId("group-favorites")).toBeTruthy();
    expect(screen.queryByTestId("group-all")).toBeNull();
  });

  it("押すと即時に上へ移り (通信の完了前)、PUT が飛ぶ。もう一度押すと元の位置へ戻り DELETE", async () => {
    let release!: () => void;
    const s = await renderList(["a", "b", "c"]);
    s.holdFavorite = new Promise<void>((r) => (release = r));
    fireEvent.click(stars()[2]!);
    expect(names()).toEqual(["Sc", "Sa", "Sb"]); // まだ応答前
    expect(stars()[0]!.getAttribute("aria-pressed")).toBe("true");
    release();
    await waitFor(() => expect(s.fav.c).toBe(true));
    expect(s.calls.filter((c) => c.url.endsWith("/favorite")).map((c) => c.method)).toEqual(["PUT"]);
    s.holdFavorite = null;
    fireEvent.click(stars()[0]!);
    expect(names()).toEqual(["Sa", "Sb", "Sc"]);
    await waitFor(() => expect(s.fav.c).toBe(false));
    expect(s.calls.filter((c) => c.url.endsWith("/favorite")).map((c) => c.method)).toEqual(["PUT", "DELETE"]);
  });

  it("失敗したら元の並びに戻り、トーストが出る", async () => {
    const s = await renderList(["a", "b", "c"]);
    s.failFavorite = true;
    fireEvent.click(stars()[2]!);
    expect(names()[0]).toBe("Sc");
    await waitFor(() => expect(names()).toEqual(["Sa", "Sb", "Sc"]));
    expect(stars()[2]!.getAttribute("aria-pressed")).toBe("false");
    expect(useUiStore.getState().toasts.some((x) => x.kind === "error")).toBe(true);
  });

  it("解除の失敗も戻る (お気に入りのまま上に残る)", async () => {
    const s = await renderList(["a", "b"], { b: true });
    s.failFavorite = true;
    fireEvent.click(stars()[0]!);
    expect(names()).toEqual(["Sa", "Sb"]);
    await waitFor(() => expect(names()).toEqual(["Sb", "Sa"]));
    expect(stars()[0]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("全体スケジュールのペインの並びも一覧 (お気に入り優先) に従う", async () => {
    await renderList(["a", "b", "c"], { c: true });
    expect(names()).toEqual(["Sc", "Sa", "Sb"]);
    fireEvent.click(screen.getByTestId("overview-filter-project"));
    expect(screen.getAllByTestId("filter-option").map((b) => b.closest("label")!.textContent)).toEqual(["Sc", "Sa", "Sb"]);
    fireEvent.click(screen.getByTestId("filter-select-all"));
    await waitFor(() => expect(screen.getAllByTestId("overview-project-name").map((n) => n.textContent)).toEqual(["Sc", "Sa", "Sb"]));
  });
});

describe("通信中の reload", () => {
  it("星の通信中に一覧が取り直されても、古い取得結果で楽観更新を上書きしない", async () => {
    let release!: () => void;
    const s = await renderList(["a", "b", "c"]);
    s.gates[0] = new Promise<void>((r) => (release = r));
    fireEvent.click(stars()[2]!); // PUT (サーバー側はまだ反映前)
    expect(names()).toEqual(["Sc", "Sa", "Sb"]);
    // 複製で reload が走る (サーバーの一覧はまだ c が星なし)
    fireEvent.click(screen.getAllByText("複製")[0]!);
    await waitFor(() => expect(s.calls.filter((c) => c.url === "/api/schedules" && c.method === "GET").length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 30));
    expect(names()).toEqual(["Sc", "Sa", "Sb"]);
    expect(stars()[0]!.getAttribute("aria-pressed")).toBe("true");
    release();
    await waitFor(() => expect(s.fav.c).toBe(true));
  });
});

describe("スケジュール画面の星の状態 (favoriteStore)", () => {
  it("noteFavorite で入り、toggle は楽観更新で PUT/DELETE、失敗で戻る", async () => {
    const s = install(["a"]);
    noteFavorite("a", false);
    await act(async () => {
      await toggleFavoriteOf("a");
    });
    expect(useFavoriteStore.getState().byId.a).toBe(true);
    expect(s.fav.a).toBe(true);
    s.failFavorite = true;
    await act(async () => {
      await toggleFavoriteOf("a");
    });
    expect(useFavoriteStore.getState().byId.a).toBe(true); // 解除に失敗 → 戻る
    expect(useUiStore.getState().toasts.length).toBe(1);
  });
  it("通信中に再同期の応答 (noteFavorite) が来ても楽観更新を上書きしない", async () => {
    let release!: () => void;
    const s = install(["a"]);
    s.holdFavorite = new Promise<void>((r) => (release = r));
    noteFavorite("a", false);
    const p = toggleFavoriteOf("a");
    noteFavorite("a", false);
    expect(useFavoriteStore.getState().byId.a).toBe(true);
    release();
    await act(async () => {
      await p;
    });
    expect(useFavoriteStore.getState().byId.a).toBe(true);
  });
  it("素早い 2 回クリック: 1 回目だけ遅延させても、サーバーへは順番に届き最後の要求が画面と一致する", async () => {
    let release!: () => void;
    const s = install(["a"]);
    s.gates[0] = new Promise<void>((r) => (release = r));
    noteFavorite("a", false);
    const p1 = toggleFavoriteOf("a"); // PUT (遅延)
    const p2 = toggleFavoriteOf("a"); // DELETE
    expect(useFavoriteStore.getState().byId.a).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.calls.filter((c) => c.url.endsWith("/favorite")).map((c) => c.method)).toEqual(["PUT"]); // 1 回目が終わるまで 2 回目は送らない
    release();
    await act(async () => {
      await Promise.all([p1, p2]);
    });
    expect(s.calls.filter((c) => c.url.endsWith("/favorite")).map((c) => c.method)).toEqual(["PUT", "DELETE"]);
    expect(s.fav.a).toBe(false);
    expect(useFavoriteStore.getState().byId.a).toBe(false);
  });
});
