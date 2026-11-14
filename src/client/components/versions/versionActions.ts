import { ApiError } from "../../schedulesApi";
import { t } from "../../i18n";
import { markSelfRestore, useAppStore } from "../../store/appStore";
import { getVersion, restoreVersion, type VersionItem } from "../../versionsApi";
import { requestConfirm, showToast } from "../uiStore";

/** バージョンを読み取り専用で表示する。成功で true。 */
export async function viewVersion(scheduleId: string, v: Pick<VersionItem, "id">): Promise<boolean> {
  try {
    const d = await getVersion(scheduleId, v.id);
    // 取得中に別のスケジュールへ移った場合は何もしない。
    if (useAppStore.getState().scheduleId !== scheduleId) return false;
    useAppStore.getState().enterViewing({ id: d.id, name: d.name, kind: d.kind, createdAt: d.createdAt, doc: d.doc });
    return true;
  } catch (e) {
    showToast("error", e instanceof ApiError && e.status === 404 ? t("versions.notFound") : t("versions.viewFailed"));
    return false;
  }
}

/** 確認してからバージョンに戻す。onDone は成功時 (変更なしを含む) に呼ぶ。 */
export function confirmRestore(scheduleId: string, v: Pick<VersionItem, "id" | "name">, onDone?: () => void): void {
  const phase = useAppStore.getState().syncPhase;
  if (phase !== "live" && phase !== "idle") return; // 切断中は戻せない
  requestConfirm({
    message: t("versions.confirmRestore", { name: v.name }),
    confirmLabel: t("versions.confirmRestoreLabel"),
    onConfirm: () => {
      void (async () => {
        markSelfRestore(true);
        try {
          const r = await restoreVersion(scheduleId, v.id);
          // 表示中だったら、現在のスケジュール (復元後) に戻る。復元後の内容は reset で全員が取り直す。
          if (useAppStore.getState().viewing !== null) useAppStore.getState().exitViewing();
          // 復元後の rev より手元が古い (reset による取り直しがまだ) なら、復元前の doc が編集できる状態で出ないよう、
          // 取り直しが終わる (live に戻る) まで読み取り専用にする。
          const cur = useAppStore.getState();
          if (r.changed && cur.rev < r.rev) useAppStore.setState({ readOnly: true, editing: null, preview: null });
          showToast("info", t(r.changed ? "versions.restored" : "versions.restoredSame", { name: v.name }));
          onDone?.();
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) showToast("error", t("versions.notFound"));
          else if (e instanceof ApiError && e.status === 422) showToast("error", t("versions.restoreInvalid"));
          else showToast("error", t("versions.restoreFailed"));
        } finally {
          // reset (WebSocket) が HTTP 応答より遅れて届くことがあるので、少し待ってから解除する。
          setTimeout(() => markSelfRestore(false), 3000);
        }
      })();
    },
  });
}
