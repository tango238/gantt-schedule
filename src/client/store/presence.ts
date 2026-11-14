import { idKey } from "../../shared/model/id";
import type { PresenceUser } from "../sync";

export interface PresenceGroup {
  userId: string;
  name: string;
  picture: string | null;
  color: string;
  self: boolean;
}

/** ユーザー単位にまとめる (自分が先頭、他は接続順)。色はそのユーザーの最初の接続の色。 */
export function groupPresence(users: readonly PresenceUser[], selfConnId: string | null): PresenceGroup[] {
  const me = users.find((u) => u.connId === selfConnId)?.userId ?? null;
  const out: PresenceGroup[] = [];
  const seen = new Set<string>();
  for (const u of users) {
    if (seen.has(u.userId)) continue;
    seen.add(u.userId);
    out.push({ userId: u.userId, name: u.name, picture: u.picture, color: u.color, self: u.userId === me });
  }
  return out.sort((a, b) => Number(b.self) - Number(a.self));
}

export interface PeerSelection {
  color: string;
  name: string;
}

/**
 * 他の接続が選択中のタスク (idKey) -> その人たち。自分の接続は除く
 * (自分の別タブの選択は他者と同様に表示する)。
 */
export function peerSelections(users: readonly PresenceUser[], selfConnId: string | null): Map<string, PeerSelection[]> {
  const map = new Map<string, PeerSelection[]>();
  for (const u of users) {
    if (u.connId === selfConnId) continue;
    for (const id of u.selectedTaskIds) {
      const k = idKey(id);
      const list = map.get(k);
      const entry = { color: u.color, name: u.name };
      if (list) list.push(entry);
      else map.set(k, [entry]);
    }
  }
  return map;
}
