import { useEffect, useState } from "react";
import { fetchAuthConfig, fetchMe, logout, type Me } from "./api";
import { AdminPage } from "./pages/AdminPage";
import { ErrorBoundary } from "./pages/ErrorBoundary";
import { ListPage } from "./pages/ListPage";
import { SchedulePage } from "./pages/SchedulePage";
import { matchRoute, navigate, useRoute } from "./router";
import "./styles/app.css";

type State = { status: "loading" } | { status: "anonymous"; devLogin: string[] } | { status: "authed"; me: Me } | { status: "error" };

export function App() {
  const [state, setState] = useState<State>({ status: "loading" });
  const route = useRoute();

  useEffect(() => {
    (async () => {
      try {
        const me = await fetchMe();
        if (me) setState({ status: "authed", me });
        else setState({ status: "anonymous", devLogin: (await fetchAuthConfig()).devLogin });
      } catch {
        setState({ status: "error" });
      }
    })();
  }, []);

  if (state.status === "loading") return <div className="center-screen">読み込み中...</div>;
  if (state.status === "error") return <div className="center-screen">読み込みに失敗しました。再読み込みしてください。</div>;
  if (state.status === "anonymous") return <LoginScreen devLogin={state.devLogin} />;

  const { me } = state;
  const onLogout = async () => {
    await logout();
    window.location.assign("/");
  };

  if (route.name === "schedule") return (
      <ErrorBoundary key={route.id}>
        <SchedulePage id={route.id} me={me} />
      </ErrorBoundary>
    );

  return (
    <div className="app">
      <header className="app-header">
        <a
          className="app-title"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          Gantt Schedule
        </a>
        <span className="spacer" />
        {me.isAdmin && (
          <a
            href="/admin"
            onClick={(e) => {
              e.preventDefault();
              navigate("/admin");
            }}
          >
            管理
          </a>
        )}
        <span className="user-name">{me.user.name}</span>
        <button onClick={onLogout}>ログアウト</button>
      </header>
      <main className={route.name === "home" ? "app-body app-body-list" : "app-body"}>
        {route.name === "home" && (
          <ErrorBoundary>
            <ListPage />
          </ErrorBoundary>
        )}
        {route.name === "admin" && <AdminPage isAdmin={me.isAdmin} />}
        {route.name === "notfound" && <p>ページが見つかりません。</p>}
      </main>
    </div>
  );
}

function LoginScreen({ devLogin }: { devLogin: string[] }) {
  // ログイン後に今の URL へ戻る。サーバー側でも相対パスのみ許可して再検証する。
  const here = window.location.pathname + window.location.search;
  const redirect = matchRoute(window.location.pathname).name === "notfound" ? "/" : here;
  const q = `?redirect=${encodeURIComponent(redirect)}`;
  return (
    <div className="center-screen">
      <div className="login-box">
        <h1>Gantt Schedule</h1>
        <a className="btn primary" href={`/auth/login${q}`}>
          Google でログイン
        </a>
        {devLogin.map((email) => (
          <a key={email} className="btn" href={`/auth/dev-login${q}&as=${encodeURIComponent(email)}`} data-testid="dev-login">
            開発用ログイン: {email}
          </a>
        ))}
      </div>
    </div>
  );
}
