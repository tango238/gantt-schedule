import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmHost } from "../components/dialogs/ConfirmDialog";
import { Modal } from "../components/dialogs/Modal";
import { SchemaErrorDialog, type DialogIssue } from "../components/dialogs/SchemaErrorDialog";
import { FavoriteButton } from "../components/FavoriteButton";
import { enqueueFavorite, favoriteEpoch, favoriteTouchedSince } from "../favorites/favoriteQueue";
import { orderFavoritesFirst } from "../favorites/order";
import { Toast } from "../components/Toast";
import { requestConfirm, showToast } from "../components/uiStore";
import { validName } from "../../shared/name";
import { t } from "../i18n";
import { OverviewPane } from "../overview/OverviewPane";
import { OverviewBoundary } from "../overview/OverviewBoundary";
import { loadSelection, pruneIds, pruneStoredCollapsed, saveSelection } from "../overview/storage";
import { navigate } from "../router";
import {
  ApiError,
  copySchedule,
  createSchedule,
  deleteSchedule,
  importSchedule,
  listSchedules,
  type ScheduleListItem,
} from "../schedulesApi";

const MAX_IMPORT_BYTES = 1024 * 1024;

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function NewDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = validName(name, 200);
  const ok = valid !== null && !busy;
  const submit = async () => {
    if (!ok || valid === null) return;
    setBusy(true);
    try {
      await onCreate(valid);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("list.newTitle")}
      onCancel={onClose}
      actions={
        <>
          <button type="button" onClick={onClose}>
            {t("dialog.cancel")}
          </button>
          <button type="button" className="primary" disabled={!ok} onClick={() => void submit()} data-testid="create-submit">
            {busy ? t("list.creating") : t("list.create")}
          </button>
        </>
      }
    >
      <label className="field-block">
        <span>{t("list.newNameLabel")}</span>
        <input
          type="text"
          data-autofocus
          data-testid="new-name"
          value={name}
          placeholder={t("list.newNamePlaceholder")}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </label>
    </Modal>
  );
}

export function ListPage() {
  const [items, setItems] = useState<ScheduleListItem[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importIssues, setImportIssues] = useState<DialogIssue[] | null>(null);
  const [imported, setImported] = useState<{ id: string; warnings: DialogIssue[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 全体スケジュールに出すスケジュール (ペインの「プロジェクト」の絞り込み。ブラウザの localStorage に保存)。
  const [checked, setChecked] = useState<string[]>(loadSelection);
  const updateChecked = useCallback((next: string[]) => {
    setChecked(next);
    saveSelection(next);
  }, []);

  const reload = useCallback(async () => {
    try {
      const since = favoriteEpoch();
      const list = await listSchedules();
      // 取得中に星を変更した行は、古い取得結果ではなく手元の値 (楽観更新・巻き戻し後) を保つ。
      setItems((cur) => {
        const local = new Map((cur ?? []).map((x) => [x.id, x.favorite]));
        return list.map((x) => (favoriteTouchedSince(x.id, since) && local.has(x.id) ? { ...x, favorite: local.get(x.id)! } : x));
      });
      pruneStoredCollapsed(new Set(list.map((s) => s.id)));
      // 削除などで存在しなくなった ID は捨てる (一覧が取れたときだけ)。
      setChecked((cur) => {
        const kept = pruneIds(cur, new Set(list.map((s) => s.id)));
        if (kept.length === cur.length) return cur;
        saveSelection(kept);
        return kept;
      });
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  // お気に入りを上に固定した並び。全体スケジュールの並びもこれに従う。
  const ordered = useMemo(() => orderFavoritesFirst(items ?? []), [items]);
  const favCount = useMemo(() => ordered.filter((s) => s.favorite).length, [ordered]);

  // 星: 即時に切り替え、失敗したら戻してトースト。同じ行の連打は順番に送る (サーバーでの追い越しを防ぐ)。
  const toggleFavorite = (s: ScheduleListItem) => {
    const id = s.id;
    const cur = items?.find((x) => x.id === id)?.favorite ?? s.favorite;
    const apply = (v: boolean) => setItems((l) => (l ? l.map((x) => (x.id === id ? { ...x, favorite: v } : x)) : l));
    apply(!cur);
    void enqueueFavorite(id, !cur).then((r) => {
      if (r.ok) return;
      // 後の操作が無ければ元に戻す。404 (削除済み) は一覧の取り直しに任せる。
      if (r.latest) apply(cur);
      if (r.error instanceof ApiError && r.error.status === 404) void reload();
      showToast("error", t("error.list.favoriteFailed"));
    });
  };

  const knownIds = useMemo(() => new Set((items ?? []).map((s) => s.id)), [items]);

  const create = async (name: string) => {
    try {
      const { id } = await createSchedule(name);
      navigate(`/s/${id}`);
    } catch {
      showToast("error", t("error.list.createFailed"));
    }
  };

  const onFile = async (file: File) => {
    if (file.size > MAX_IMPORT_BYTES) {
      showToast("error", t("error.list.importTooLarge"));
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(await file.text());
    } catch (e) {
      setImportIssues([{ code: "PARSE_ERROR", path: "", params: { message: e instanceof Error ? e.message : String(e) } }]);
      return;
    }
    try {
      const { id, warnings } = await importSchedule(json);
      if (warnings && warnings.length > 0) setImported({ id, warnings });
      else navigate(`/s/${id}`);
    } catch (e) {
      if (e instanceof ApiError && e.issues) setImportIssues(e.issues);
      else if (e instanceof ApiError && e.status === 413) showToast("error", t("error.list.importTooLarge"));
      else showToast("error", t("error.list.importFailed"));
    }
  };

  const copy = async (s: ScheduleListItem) => {
    try {
      await copySchedule(s.id);
      await reload();
    } catch {
      showToast("error", t("error.list.copyFailed"));
    }
  };

  const remove = (s: ScheduleListItem) =>
    requestConfirm({
      message: t("list.confirmDelete", { name: s.name || t("list.untitled") }),
      confirmLabel: t("list.delete"),
      onConfirm: () => {
        void (async () => {
          try {
            await deleteSchedule(s.id);
          } catch (e) {
            if (!(e instanceof ApiError && e.status === 404)) showToast("error", t("error.list.deleteFailed"));
          }
          await reload();
        })();
      },
    });

  const renderRow = (s: ScheduleListItem) => (
        <tr key={s.id} data-testid="schedule-row">
          <td className="col-fav">
            <FavoriteButton name={s.name || t("list.untitled")} pressed={s.favorite} onToggle={() => toggleFavorite(s)} />
          </td>
          <td className="col-name" title={s.name}>
            <a
              href={`/s/${s.id}`}
              onClick={(e) => {
                e.preventDefault();
                navigate(`/s/${s.id}`);
              }}
            >
              {s.name || t("list.untitled")}
            </a>
          </td>
          <td className="col-date">{formatDateTime(s.updatedAt)}</td>
          <td className="col-user" title={s.updatedBy.email}>
            {s.updatedBy.name || s.updatedBy.email}
          </td>
          <td className="col-actions">
            <button type="button" onClick={() => navigate(`/s/${s.id}`)}>
              {t("list.open")}
            </button>
            <button type="button" onClick={() => void copy(s)}>
              {t("list.copy")}
            </button>
            <button type="button" className="danger-text" onClick={() => remove(s)}>
              {t("list.delete")}
            </button>
          </td>
        </tr>
  );

  return (
    <div className="list-shell">
    <div className="list-scroll">
    <div className="list-page" data-testid="list-page">
      <div className="list-head">
        <h1>{t("list.title")}</h1>
        <span className="spacer" />
        <button type="button" onClick={() => fileRef.current?.click()} data-testid="import-json">
          {t("list.import")}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          data-testid="import-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = ""; // 同じファイルを続けて選べるように
            if (f) void onFile(f);
          }}
        />
        <button type="button" className="primary" onClick={() => setCreating(true)} data-testid="new-schedule">
          {t("list.new")}
        </button>
      </div>

      {loadError && (
        <p className="list-error" role="alert">
          {t("error.list.loadFailed")}{" "}
          <button type="button" onClick={() => void reload()}>
            {t("page.retry")}
          </button>
        </p>
      )}
      {items === null && !loadError && <p className="list-muted">{t("list.loading")}</p>}
      {items !== null && items.length === 0 && (
        <div className="list-empty" data-testid="list-empty">
          <p className="list-empty-title">{t("list.empty")}</p>
          <p>{t("list.emptyHint")}</p>
        </div>
      )}
      {items !== null && items.length > 0 && (
        <table className="list-table">
          <thead>
            <tr>
              <th className="col-fav">
                <span className="visually-hidden">{t("list.favorites")}</span>
              </th>
              <th className="col-name">{t("list.name")}</th>
              <th className="col-date">{t("list.updatedAt")}</th>
              <th className="col-user">{t("list.updatedBy")}</th>
              <th className="col-actions col-actions-3" />
            </tr>
          </thead>
          {favCount > 0 ? (
            <>
              <tbody>
                <tr className="list-group" data-testid="group-favorites">
                  <th colSpan={5} scope="rowgroup">{t("list.favorites")}</th>
                </tr>
                {ordered.slice(0, favCount).map(renderRow)}
              </tbody>
              {favCount < ordered.length && (
                <tbody>
                  <tr className="list-group" data-testid="group-all">
                    <th colSpan={5} scope="rowgroup">{t("list.allSchedules")}</th>
                  </tr>
                  {ordered.slice(favCount).map(renderRow)}
                </tbody>
              )}
            </>
          ) : (
            <tbody>{ordered.map(renderRow)}</tbody>
          )}
        </table>
      )}

      {creating && <NewDialog onClose={() => setCreating(false)} onCreate={create} />}
      {imported && (
        <SchemaErrorDialog
          title={t("list.importWarningsTitle", { count: imported.warnings.length })}
          issues={imported.warnings}
          onClose={() => {
            const id = imported.id;
            setImported(null);
            navigate(`/s/${id}`);
          }}
        />
      )}
      {importIssues && <SchemaErrorDialog issues={importIssues} onClose={() => setImportIssues(null)} />}
      <Toast />
      <ConfirmHost />
    </div>
    </div>
    {ordered.length > 0 && (
      <OverviewBoundary resetKey={checked.join(",")} onClearAll={() => updateChecked([])}>
        <OverviewPane items={ordered} selected={checked} onSelectedChange={updateChecked} knownIds={knownIds} />
      </OverviewBoundary>
    )}
    </div>
  );
}
