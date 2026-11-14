import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../i18n";

interface Props {
  /** 選んだスケジュールの組み合わせ。変わったら再表示を試す。 */
  resetKey: string;
  onClearAll: () => void;
  children: ReactNode;
}

/** 全体スケジュールの描画で例外が出ても、一覧ページ全体は残す。 */
export class OverviewBoundary extends Component<Props, { failed: boolean; key: string }> {
  state = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromProps(props: Props, state: { failed: boolean; key: string }) {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("overview render error", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="overview-pane overview-failed" role="alert" data-testid="overview-error">
        <span>{t("overview.paneFailed")}</span>
        <button type="button" onClick={this.props.onClearAll} data-testid="overview-clear">
          {t("overview.clearAll")}
        </button>
      </section>
    );
  }
}
