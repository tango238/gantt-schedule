import { useCallback, useEffect, useState } from "react";
import { ConfirmHost } from "../components/dialogs/ConfirmDialog";
import { Toast } from "../components/Toast";
import { requestConfirm, showToast } from "../components/uiStore";
import { normalizeEmail } from "../../shared/email";
import {
  addAllowedEmail,
  fetchAdminConfig,
  fetchAllowedEmails,
  fetchDeletedSchedules,
  fetchUsers,
  removeAllowedEmail,
  restoreSchedule,
  type AccessReason,
  type AdminConfig,
  type AllowedEmailItem,
  type DeletedScheduleItem,
  type PersonRef,
  type UserItem,
} from "../adminApi";
import { t } from "../i18n";
import { navigate } from "../router";
import { ApiError } from "../schedulesApi";
import { formatDateTime } from "./ListPage";

const person = (p: PersonRef | null) => (p ? p.name || p.email : t("admin.unknownPerson"));

/** 一覧の読み込み状態つきフック。 */
function useLoad<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(async () => {
    try {
      setData(await fn());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [fn]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, failed, reload };
}

function LoadState({ data, failed, reload }: { data: unknown; failed: boolean; reload: () => Promise<void> }) {
  if (failed)
    return (
      <p className="list-error" role="alert">
        {t("admin.loadFailed")}{" "}
        <button type="button" onClick={() => void reload()}>
          {t("page.retry")}
        </button>
      </p>
    );
  if (data === null) return <p className="list-muted">{t("list.loading")}</p>;
  return null;
}

function ExceptionsSection() {
  const config = useLoad<AdminConfig>(fetchAdminConfig);
  const { data, failed, reload } = useLoad<AllowedEmailItem[]>(fetchAllowedEmails);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const normalized = normalizeEmail(email);
  const canAdd = normalized !== null && !busy;

  const add = async () => {
    if (normalized === null || busy) return;
    setBusy(true);
    try {
      const r = await addAllowedEmail(normalized);
      showToast("info", r.created ? t("admin.exceptions.added", { email: r.email }) : t("admin.exceptions.alreadyExists", { email: r.email }));
      setEmail("");
      await reload();
    } catch (e) {
      showToast("error", e instanceof ApiError && e.error === "invalid_email" ? t("admin.exceptions.invalid") : t("admin.exceptions.addFailed"));
    } finally {
      setBusy(false);
    }
  };

  const remove = (item: AllowedEmailItem) =>
    requestConfirm({
      message: t("admin.exceptions.confirmRemove", { email: item.email }),
      confirmLabel: t("list.delete"),
      onConfirm: () => {
        void (async () => {
          try {
            await removeAllowedEmail(item.email);
          } catch (e) {
            if (!(e instanceof ApiError && e.status === 404)) showToast("error", t("admin.exceptions.removeFailed"));
          }
          await reload();
        })();
      },
    });

  return (
    <section className="admin-section" data-testid="admin-exceptions">
      <h2>{t("admin.exceptions.title")}</h2>
      <p className="admin-help">{t("admin.exceptions.help")}</p>
      <dl className="admin-config">
        <dt>{t("admin.config.domains")}</dt>
        <dd data-testid="admin-domains">
          {config.data === null ? "…" : config.data.allowedDomains.length > 0 ? config.data.allowedDomains.join(", ") : t("admin.config.none")}
        </dd>
        <dt>{t("admin.config.admins")}</dt>
        <dd data-testid="admin-admins">
          {config.data === null ? "…" : config.data.adminEmails.length > 0 ? config.data.adminEmails.join(", ") : t("admin.config.none")}
        </dd>
      </dl>
      <p className="admin-help">{t("admin.config.note")}</p>

      <form
        className="admin-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          type="text"
          inputMode="email"
          autoComplete="off"
          value={email}
          placeholder={t("admin.exceptions.placeholder")}
          aria-label={t("admin.exceptions.inputLabel")}
          data-testid="exception-input"
          onChange={(e) => setEmail(e.target.value)}
        />
        <button type="submit" className="primary" disabled={!canAdd} data-testid="exception-add">
          {t("admin.exceptions.add")}
        </button>
      </form>

      <LoadState data={data} failed={failed} reload={reload} />
      {data !== null && data.length === 0 && <p className="list-muted" data-testid="exceptions-empty">{t("admin.exceptions.empty")}</p>}
      {data !== null && data.length > 0 && (
        <table className="list-table">
          <thead>
            <tr>
              <th className="col-name">{t("admin.exceptions.email")}</th>
              <th className="col-user">{t("admin.exceptions.addedBy")}</th>
              <th className="col-date">{t("admin.exceptions.addedAt")}</th>
              <th className="col-actions col-actions-1" />
            </tr>
          </thead>
          <tbody>
            {data.map((x) => (
              <tr key={x.email} data-testid="exception-row">
                <td className="col-name" title={x.email}>{x.email}</td>
                <td className="col-user" title={x.addedBy?.email}>{person(x.addedBy)}</td>
                <td className="col-date">{formatDateTime(x.createdAt)}</td>
                <td className="col-actions">
                  <button type="button" className="danger-text" onClick={() => remove(x)}>
                    {t("list.delete")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const accessKey = (a: AccessReason) => `admin.users.access.${a ?? "denied"}`;

function UsersSection() {
  const { data, failed, reload } = useLoad<UserItem[]>(fetchUsers);
  return (
    <section className="admin-section" data-testid="admin-users">
      <h2>{t("admin.users.title")}</h2>
      <p className="admin-help">{t("admin.users.help")}</p>
      <LoadState data={data} failed={failed} reload={reload} />
      {data !== null && data.length === 0 && <p className="list-muted">{t("admin.users.empty")}</p>}
      {data !== null && data.length > 0 && (
        <table className="list-table">
          <thead>
            <tr>
              <th className="col-user">{t("admin.users.name")}</th>
              <th className="col-name">{t("admin.users.email")}</th>
              <th className="col-date">{t("admin.users.lastLogin")}</th>
              <th className="col-access">{t("admin.users.accessHeader")}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((u) => (
              <tr key={u.email} data-testid="user-row">
                <td className="col-user" title={u.name}>{u.name || "-"}</td>
                <td className="col-name" title={u.email}>{u.email}</td>
                <td className="col-date">{formatDateTime(u.lastLoginAt)}</td>
                <td className={u.access === null ? "admin-denied" : undefined}>{t(accessKey(u.access))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function DeletedSection() {
  const { data, failed, reload } = useLoad<DeletedScheduleItem[]>(fetchDeletedSchedules);
  const restore = async (s: DeletedScheduleItem) => {
    try {
      await restoreSchedule(s.id);
      showToast("info", t("admin.deleted.restored", { name: s.name || t("list.untitled") }));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) showToast("error", t("admin.deleted.restoreFailed"));
    }
    await reload();
  };
  return (
    <section className="admin-section" data-testid="admin-deleted">
      <h2>{t("admin.deleted.title")}</h2>
      <p className="admin-help">{t("admin.deleted.help")}</p>
      <LoadState data={data} failed={failed} reload={reload} />
      {data !== null && data.length === 0 && <p className="list-muted" data-testid="deleted-empty">{t("admin.deleted.empty")}</p>}
      {data !== null && data.length > 0 && (
        <table className="list-table">
          <thead>
            <tr>
              <th className="col-name">{t("list.name")}</th>
              <th className="col-date">{t("admin.deleted.deletedAt")}</th>
              <th className="col-user">{t("admin.deleted.deletedBy")}</th>
              <th className="col-actions col-actions-1" />
            </tr>
          </thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id} data-testid="deleted-row">
                <td className="col-name" title={s.name}>{s.name || t("list.untitled")}</td>
                <td className="col-date">{formatDateTime(s.deletedAt)}</td>
                <td className="col-user" title={s.deletedBy?.email}>{person(s.deletedBy)}</td>
                <td className="col-actions">
                  <button type="button" onClick={() => void restore(s)} data-testid="restore">
                    {t("admin.deleted.restore")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function AdminPage({ isAdmin }: { isAdmin: boolean }) {
  if (!isAdmin)
    return (
      <div className="list-page" data-testid="admin-forbidden">
        <p>{t("admin.forbidden")}</p>
        <BackLink />
      </div>
    );
  return (
    <div className="list-page admin-page" data-testid="admin-page">
      <div className="list-head">
        <h1>{t("admin.title")}</h1>
        <span className="spacer" />
        <BackLink />
      </div>
      <ExceptionsSection />
      <UsersSection />
      <DeletedSection />
      <Toast />
      <ConfirmHost />
    </div>
  );
}

function BackLink() {
  return (
    <a
      href="/"
      data-testid="admin-back"
      onClick={(e) => {
        e.preventDefault();
        navigate("/");
      }}
    >
      {t("admin.back")}
    </a>
  );
}
