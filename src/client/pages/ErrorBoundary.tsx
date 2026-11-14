import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../i18n";
import { navigate } from "../router";

/** 描画中の例外で画面が真っ白にならないようにする (想定外の doc がサーバーから来た場合など)。 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("render error", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="center-screen">
        <div className="notice-box" role="alert" data-testid="render-error">
          <h1>{t("page.renderErrorTitle")}</h1>
          <p>{t("page.renderErrorBody")}</p>
          <a
            className="btn"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate("/");
            }}
          >
            {t("page.backToList")}
          </a>
        </div>
      </div>
    );
  }
}
