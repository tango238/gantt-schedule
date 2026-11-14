import { useEffect } from "react";
import { create } from "zustand";
import { todayIso } from "../shared/model/date";

/**
 * 「閲覧者のローカルの今日」を 1 か所で保持し、1 分ごとに日付が変わったか確かめて更新する
 * (期限超過の判定・今日線が日をまたいでも古くならない)。チャート・ステータスバー・右ペインが同じ値を使う。
 */
const useTodayStore = create<{ today: string }>()(() => ({ today: todayIso() }));

let timer: ReturnType<typeof setInterval> | null = null;
let users = 0;

function refresh(): void {
  const now = todayIso();
  if (now !== useTodayStore.getState().today) useTodayStore.setState({ today: now });
}

export function useToday(): string {
  const today = useTodayStore((s) => s.today);
  useEffect(() => {
    if (users++ === 0) {
      refresh();
      timer = setInterval(refresh, 60_000);
    }
    return () => {
      if (--users === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return today;
}

/** テスト用。 */
export const refreshTodayForTest = refresh;
