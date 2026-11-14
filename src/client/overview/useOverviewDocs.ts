import { useCallback, useEffect, useRef, useState } from "react";
import type { GanttDocument } from "../../shared/model/types";
import { loadDocument } from "../../shared/engine";
import { ApiError, request } from "../schedulesApi";

export type DocState =
  | { status: "loading" }
  | { status: "error"; reason: "notfound" | "failed" | "invalid" }
  | { status: "ok"; doc: GanttDocument; name: string };

/** 同時に取得するスケジュールの数。 */
export const FETCH_CONCURRENCY = 4;

/** 取り消された (待ち行列から外れた・実行前に不要になった) ことを表す。 */
export class CancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

export type Limiter = <T>(fn: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) => Promise<T>;

/**
 * 同時実行数を絞る (待ち行列つき)。signal が中断されたら、待ち行列にいるものは外して CancelledError で終わり、
 * 実行中のものには signal が渡るので fn 側で中断する。実行直前に中断済みなら fn は呼ばない。
 */
export function createLimiter(limit: number): Limiter {
  let active = 0;
  const queue: Array<{ start: () => void; cancel: () => void }> = [];
  const pump = () => {
    while (active < limit && queue.length > 0) queue.shift()!.start();
  };
  return <T,>(fn: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) =>
    new Promise<T>((resolve, reject) => {
      if (signal.aborted) return reject(new CancelledError());
      const job = {
        start: () => {
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) return reject(new CancelledError());
          active++;
          fn(signal).then(resolve, reject).finally(() => {
            active--;
            pump();
          });
        },
        cancel: () => reject(new CancelledError()),
      };
      const onAbort = () => {
        const i = queue.indexOf(job);
        if (i >= 0) {
          queue.splice(i, 1);
          job.cancel();
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      queue.push(job);
      pump();
    });
}

/** 全体で同時 FETCH_CONCURRENCY 件まで (複数のペイン・再チェックをまたいで守る)。 */
const globalLimiter = createLimiter(FETCH_CONCURRENCY);

/** スケジュール画面と同じ検証 (loadDocument) に通す。通らない・壊れている doc は null。 */
export function validateDoc(raw: unknown): GanttDocument | null {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const strs = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));
  try {
    if (!isObj(raw) || !isObj(raw.project) || !Array.isArray(raw.tasks)) return null;
    for (const k of ["resources", "colorLabels"] as const) {
      const list = raw[k];
      if (list !== undefined && (!Array.isArray(list) || !list.every((x) => isObj(x) && typeof x.id === "string"))) return null;
    }
    for (const task of raw.tasks) {
      if (!isObj(task) || typeof task.id !== "string" || typeof task.name !== "string") return null;
      if (!strs(task.assigneeIds) || !strs(task.resourceIds)) return null;
      if (task.dependencies !== undefined && (!Array.isArray(task.dependencies) || !task.dependencies.every((d) => isObj(d) && typeof d.predecessorId === "string"))) return null;
      if (task.parentId != null && typeof task.parentId !== "string") return null;
    }
    const r = loadDocument(raw as unknown as GanttDocument);
    return r.ok ? r.doc : null;
  } catch {
    return null;
  }
}

interface Detail {
  name: string;
  doc: GanttDocument;
}

/** 既存の GET /api/schedules/:id で 1 件取得する (WebSocket は張らない)。 */
export async function fetchDoc(id: string, signal?: AbortSignal): Promise<DocState> {
  try {
    const d = await request<Detail>(`/api/schedules/${encodeURIComponent(id)}`, { cache: "no-store", ...(signal ? { signal } : {}) });
    const doc = validateDoc(d?.doc);
    if (doc === null) return { status: "error", reason: "invalid" };
    return { status: "ok", doc, name: typeof d.name === "string" ? d.name : "" };
  } catch (e) {
    return { status: "error", reason: e instanceof ApiError && e.status === 404 ? "notfound" : "failed" };
  }
}

export interface OverviewDocs {
  docs: ReadonlyMap<string, DocState>;
  /** 最後にデータが届いた時刻 (まだ何も届いていなければ null)。 */
  fetchedAt: number | null;
  /** 取得中のものがあるか。 */
  busy: boolean;
  refresh: () => void;
}

/** 取得の世代番号 (全体で単調増加)。外して付け直したとき、古い応答が新しい応答を上書きしない。 */
let fetchSeq = 0;

/**
 * チェックされたスケジュールの doc を取得する。新しく加わった ID だけ取りに行き、「更新」で全件を取り直す
 * (取り直し中も前の内容を表示し続ける)。チェックが外れた ID・アンマウントされたものは待ち行列から外し、通信中なら中断する。
 */
export function useOverviewDocs(
  ids: readonly string[],
  fetcher: (id: string, signal: AbortSignal) => Promise<DocState> = fetchDoc,
  limiter: Limiter = globalLimiter,
): OverviewDocs {
  const [docs, setDocs] = useState<ReadonlyMap<string, DocState>>(new Map());
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [pending, setPending] = useState(0);
  const latest = useRef(new Map<string, { n: number; ctrl: AbortController }>());
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const map = latest.current;
    return () => {
      alive.current = false;
      for (const v of map.values()) v.ctrl.abort();
      map.clear();
    };
  }, []);

  const load = useCallback(
    (id: string) => {
      latest.current.get(id)?.ctrl.abort();
      const n = ++fetchSeq;
      const ctrl = new AbortController();
      latest.current.set(id, { n, ctrl });
      setPending((c) => c + 1);
      limiter((signal) => fetcherRef.current(id, signal), ctrl.signal).then(
        (st) => {
          if (!alive.current) return;
          setPending((c) => c - 1);
          if (latest.current.get(id)?.n !== n) return; // 新しい取得が始まった (または外された)
          setDocs((m) => new Map(m).set(id, st));
          setFetchedAt(Date.now());
        },
        () => {
          if (!alive.current) return;
          setPending((c) => c - 1);
          if (latest.current.get(id)?.n !== n || ctrl.signal.aborted) return;
          setDocs((m) => new Map(m).set(id, { status: "error", reason: "failed" }));
        },
      );
    },
    [limiter],
  );

  const key = ids.join("\n");
  useEffect(() => {
    const want = new Set(ids);
    for (const id of ids) {
      if (!latest.current.has(id)) {
        setDocs((m) => (m.has(id) ? m : new Map(m).set(id, { status: "loading" })));
        load(id);
      }
    }
    for (const [id, v] of [...latest.current]) {
      if (!want.has(id)) {
        v.ctrl.abort();
        latest.current.delete(id);
        setDocs((m) => {
          if (!m.has(id)) return m;
          const next = new Map(m);
          next.delete(id);
          return next;
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load]);

  const refresh = useCallback(() => {
    for (const id of [...latest.current.keys()]) load(id);
  }, [load]);

  return { docs, fetchedAt, busy: pending > 0, refresh };
}
