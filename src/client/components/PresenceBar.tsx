import { t } from "../i18n";
import { useAppStore } from "../store/appStore";
import { groupPresence } from "../store/presence";

/** ヘッダーの接続中ユーザー。同一ユーザーの複数タブは 1 つにまとめる。 */
export function PresenceBar() {
  const presence = useAppStore((s) => s.presence);
  const selfConnId = useAppStore((s) => s.selfConnId);
  const users = groupPresence(presence, selfConnId);
  if (users.length === 0) return null;
  return (
    <div className="presence-bar" role="list" aria-label={t("page.presenceLabel")} data-testid="presence-bar">
      {users.map((u) => {
        const title = u.self ? t("page.presenceYou", { name: u.name }) : u.name;
        return (
          <span
            key={u.userId}
            className={`avatar${u.self ? " self" : ""}`}
            role="listitem"
            title={title}
            aria-label={title}
            data-testid="presence-avatar"
            data-user-id={u.userId}
            data-self={u.self ? "1" : "0"}
            style={{ borderColor: u.color }}
          >
            {u.picture ? (
              <img src={u.picture} alt="" referrerPolicy="no-referrer" />
            ) : (
              <span className="avatar-initial" style={{ background: u.color }}>
                {initialOf(u.name)}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function initialOf(name: string): string {
  const ch = Array.from(name.trim())[0];
  return ch ? ch.toUpperCase() : "?";
}
