import { useEffect, useMemo, useState } from "react";
import { ChartView } from "../components/chart/ChartView";
import { ConfirmHost } from "../components/dialogs/ConfirmDialog";
import { SidePanel } from "../components/SidePanel/SidePanel";
import { StatusBar } from "../components/StatusBar";
import { Toast } from "../components/Toast";
import { FavoriteButton } from "../components/FavoriteButton";
import { toggleFavoriteOf, useFavoriteStore } from "../favorites/favoriteStore";
import { Toolbar } from "../components/Toolbar";
import { useKeyboard } from "../components/useKeyboard";
import { ZoomSwitch } from "../components/ZoomSwitch";
import { downloadJson } from "../exportJson";
import { t } from "../i18n";
import { navigate } from "../router";
import { VersionBanner } from "../components/versions/VersionBanner";
import { VersionsDialog } from "../components/versions/VersionsDialog";
import { PresenceBar } from "../components/PresenceBar";
import { AiPane } from "../components/AiPane/AiPane";
import { AiSettingsHost } from "../components/AiPane/AiSettingsDialog";
import { resetConversation } from "../ai/aiActions";
import { useAiStore } from "../ai/aiStore";
import { useAiShortcut } from "../ai/shortcut";
import { useAppStore, type SaveStatus } from "../store/appStore";
import { refreshIfUnknown, USERS_REFRESH_MS, useUsersStore } from "../users/usersStore";
import type { Me } from "../api";

function BackLink() {
  return (
    <a
      className="back-link"
      href="/"
      onClick={(e) => {
        e.preventDefault();
        navigate("/");
      }}
    >
      <span aria-hidden="true">←</span> {t("header.back")}
    </a>
  );
}

function HeaderFavorite({ id, name }: { id: string; name: string }) {
  const favorite = useFavoriteStore((s) => s.byId[id] === true);
  return <FavoriteButton name={name} pressed={favorite} onToggle={() => void toggleFavoriteOf(id)} />;
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  if (status === "idle") return <span className="save-status" />;
  return (
    <span className={`save-status save-${status}`} role="status" data-testid="save-status">
      {t(`saveStatus.${status}`)}
    </span>
  );
}

export function SchedulePage({ id, me }: { id: string; me: Me }) {
  const loadStatus = useAppStore((s) => s.loadStatus);
  const doc = useAppStore((s) => s.doc);
  const saveStatus = useAppStore((s) => s.saveStatus);
  const pending = useAppStore((s) => s.pending);
  const viewing = useAppStore((s) => s.viewing);
  const sidePanelOpen = useAppStore((s) => s.sidePanelOpen);
  const openSchedule = useAppStore((s) => s.openSchedule);
  const closeSchedule = useAppStore((s) => s.closeSchedule);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const aiOpen = useAiStore((s) => s.open);
  const toggleAi = useAiStore((s) => s.toggle);
  useKeyboard();
  useAiShortcut();

  useEffect(() => {
    void openSchedule(id);
    return () => {
      closeSchedule();
      // 会話履歴は保存しない: 別のスケジュールへ移る・ページを離れると消える。
      resetConversation();
    };
  }, [id, openSchedule, closeSchedule]);

  // 保存待ちのコマンドがあるまま閉じようとしたら確認する。
  useEffect(() => {
    if (pending === 0) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [pending]);

  // doc の担当に一覧に無い ID があれば (他の人が初めてログインした直後など) ユーザー一覧を取り直す (最短 15 秒間隔)。
  const userNames = useUsersStore((s) => s.names);
  const assigneeKey = useMemo(() => {
    const ids = new Set<string>();
    for (const t of doc?.tasks ?? []) for (const u of t.assigneeIds ?? []) ids.add(u);
    return [...ids].sort().join("\n");
  }, [doc?.tasks]);
  useEffect(() => {
    if (assigneeKey === "") return;
    const ids = assigneeKey.split("\n");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    void refreshIfUnknown(ids).then((r) => {
      // 取得間隔の制限で取り直せなかったときだけ、間隔が過ぎたあとに 1 回再試行する。
      if (r === "throttled" && !cancelled) timer = setTimeout(() => void refreshIfUnknown(ids), USERS_REFRESH_MS + 500);
    });
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [assigneeKey, userNames]);

  const name = doc?.project.name;
  useEffect(() => {
    document.title = name ? `${name} - ${t("app.name")}` : t("app.name");
    return () => {
      document.title = t("app.name");
    };
  }, [name]);

  if (loadStatus === "notfound") {
    return (
      <div className="center-screen">
        <div className="notice-box" data-testid="not-found">
          <h1>{t("page.notFoundTitle")}</h1>
          <p>{t("page.notFoundBody")}</p>
          <a className="btn" href="/" onClick={(e) => { e.preventDefault(); navigate("/"); }}>
            {t("page.backToList")}
          </a>
        </div>
      </div>
    );
  }
  if (loadStatus === "deleted") {
    return (
      <div className="center-screen">
        <div className="notice-box" data-testid="deleted">
          <h1>{t("page.deletedTitle")}</h1>
          <p>{t("page.deletedBody")}</p>
          <a className="btn" href="/" onClick={(e) => { e.preventDefault(); navigate("/"); }}>
            {t("page.backToList")}
          </a>
        </div>
      </div>
    );
  }
  if (loadStatus === "error") {
    return (
      <div className="center-screen">
        <div className="notice-box">
          <h1>{t("page.loadError")}</h1>
          <button type="button" onClick={() => void openSchedule(id)}>
            {t("page.retry")}
          </button>
        </div>
      </div>
    );
  }
  if (loadStatus !== "ready" || doc === null) return <div className="center-screen">{t("page.loading")}</div>;

  return (
    <div className="app">
      <header className="app-header schedule-header">
        <BackLink />
        <h1 className="schedule-name" title={doc.project.name} data-testid="schedule-name">
          {doc.project.name || t("list.untitled")}
        </h1>
        <HeaderFavorite id={id} name={doc.project.name || t("list.untitled")} />
        <SaveIndicator status={saveStatus} />
        <span className="spacer" />
        <PresenceBar />
        <ZoomSwitch />
        <button
          type="button"
          className={aiOpen ? "active" : undefined}
          aria-pressed={aiOpen}
          title={t("ai.toggleTitle")}
          data-testid="ai-toggle"
          onClick={toggleAi}
        >
          {t("ai.button")}
        </button>
        <button type="button" title={t("header.versionsTitle")} data-testid="versions-button" onClick={() => setVersionsOpen(true)}>
          {t("header.versions")}
        </button>
        <button type="button" title={t("header.exportJsonTitle")} data-testid="export-json" onClick={() => downloadJson(doc, viewing?.name)}>
          {t("header.exportJson")}
        </button>
        <span className="user-name" title={me.user.email}>
          {me.user.name}
        </span>
      </header>
      <VersionBanner scheduleId={id} />
      <Toolbar />
      <div className="app-main">
        <ChartView />
        <aside className="side-panel" hidden={!sidePanelOpen}>
          <SidePanel />
        </aside>
      </div>
      <AiPane />
      <footer className="status-bar">
        <StatusBar />
      </footer>
      {versionsOpen && <VersionsDialog scheduleId={id} onClose={() => setVersionsOpen(false)} />}
      <AiSettingsHost />
      <Toast />
      <ConfirmHost />
    </div>
  );
}
