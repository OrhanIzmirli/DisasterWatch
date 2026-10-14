import { useCallback, useEffect, useState } from "react";
import type { AuthUser } from "../../App";
import { formatDateTime } from "../../utils/formatDate";

/**
 * Admin console > Users: search, paged table, detail panel with
 * Disable / Enable and a typed-confirmation Delete. No user creation and
 * no role editing here by design (invitations come with the e-mail PR,
 * roles come from ADMIN_EMAILS). Admin accounts show no actions.
 */

type UserRow = {
  id: number;
  email: string;
  role: string;
  createdAt: string;
  lastLoginAt: string | null;
  disabledAt: string | null;
  subscriptionCount: number;
};

type Subscription = {
  id: number;
  label: string;
  type: string;
  minSeverity: string;
  radiusKm: number;
  active: boolean;
  createdAt: string;
};

type UserDetail = UserRow & {
  subscriptions: Subscription[];
  notificationCount: number;
};

type ListResponse = {
  items: UserRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

type Props = {
  currentUser: AuthUser | null;
};

const NOT_YET = "Never";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    ...init,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || `Request failed (${res.status})`);
  return data as T;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function StatusBadge({ user }: { user: UserRow }) {
  if (user.role === "admin") return <span className="status-badge status-badge-admin">Admin</span>;
  if (user.disabledAt) return <span className="status-badge status-badge-disabled">Disabled</span>;
  return <span className="status-badge status-badge-active">Active</span>;
}

function DeleteDialog({
  user,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  user: UserDetail;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (confirmEmail: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const matches = typed.trim().toLowerCase() === user.email.toLowerCase();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <>
      <div className="dw-modal-overlay" onClick={onCancel} />
      <div className="dw-modal card" role="dialog" aria-modal="true" aria-labelledby="delete-user-title">
        <h3 id="delete-user-title" className="dw-modal-title">
          Delete user
        </h3>
        <p className="dw-modal-text">
          This permanently removes <strong>{user.email}</strong>, their {user.subscriptionCount}{" "}
          {user.subscriptionCount === 1 ? "subscription" : "subscriptions"} and {user.notificationCount}{" "}
          {user.notificationCount === 1 ? "notification" : "notifications"}. It cannot be undone.
        </p>
        <form
          className="form-field"
          onSubmit={(e) => {
            e.preventDefault();
            if (matches && !busy) onConfirm(typed.trim());
          }}
        >
          <label htmlFor="delete-confirm-email">Type the user's e-mail address to confirm</label>
          <input
            id="delete-confirm-email"
            autoFocus
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={user.email}
          />
          {error && <div className="form-error">{error}</div>}
          <div className="card-actions dw-modal-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn-danger btn-sm" disabled={!matches || busy}>
              {busy ? "Deleting…" : "Delete user"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

export default function UsersTab({ currentUser }: Props) {
  const [query, setQuery] = useState("");
  const [q, setQ] = useState(""); // committed search
  const [page, setPage] = useState(1);
  const [list, setList] = useState<ListResponse | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (page > 1) params.set("page", String(page));
      const data = await api<ListResponse>(`/api/admin/users${params.size ? `?${params}` : ""}`);
      setList(data);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Could not load users.");
    } finally {
      setLoading(false);
    }
  }, [q, page]);

  const loadDetail = useCallback(async (id: number) => {
    setDetailError(null);
    try {
      const data = await api<{ user: UserDetail }>(`/api/admin/users/${id}`);
      setDetail(data.user);
    } catch (e) {
      setDetail(null);
      setDetailError(e instanceof Error ? e.message : "Could not load the user.");
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const search = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setQ(query.trim().toLowerCase());
  };

  const runAction = async (path: string, init: RequestInit, done: (d: UserDetail | null) => string) => {
    if (!detail) return;
    setActionBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await api(path, init);
      const refreshed = path.endsWith("/disable") || path.endsWith("/enable") ? await api<{ user: UserDetail }>(`/api/admin/users/${detail.id}`) : null;
      setNotice(done(refreshed?.user ?? null));
      if (refreshed) setDetail(refreshed.user);
      else {
        setSelectedId(null);
        setConfirmDelete(false);
      }
      await loadList();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setActionBusy(false);
    }
  };

  const disable = () => runAction(`/api/admin/users/${detail!.id}/disable`, { method: "POST" }, () => `${detail!.email} disabled; all of their sessions are ended.`);
  const enable = () => runAction(`/api/admin/users/${detail!.id}/enable`, { method: "POST" }, () => `${detail!.email} enabled; they can sign in again.`);
  const remove = (confirmEmail: string) =>
    runAction(`/api/admin/users/${detail!.id}`, { method: "DELETE", body: JSON.stringify({ confirmEmail }) }, () => `${detail!.email} deleted.`);

  const canAct = detail && detail.role !== "admin" && detail.email !== currentUser?.email;

  return (
    <>
      <section className="card">
        <div className="card-title">
          Users
          <span className="muted">{list ? `${list.total} total` : ""}</span>
        </div>

        <form className="admin-search" onSubmit={search} role="search">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by e-mail…"
            aria-label="Search users by e-mail"
          />
          <button type="submit" className="btn btn-secondary btn-sm" disabled={loading}>
            Search
          </button>
          {q && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setQuery("");
                setQ("");
                setPage(1);
              }}
            >
              Clear
            </button>
          )}
        </form>

        {notice && <div className="form-success">{notice}</div>}
        {listError && <div className="form-error">{listError}</div>}

        {list && list.items.length === 0 && !loading && <div className="muted">No users match.</div>}

        {list && list.items.length > 0 && (
          <div className="table-wrap">
            <table className="data-table admin-users-table">
              <thead>
                <tr>
                  <th>E-mail</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Last sign-in</th>
                  <th>Subs</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((u) => (
                  <tr
                    key={u.id}
                    className={"admin-user-row" + (u.id === selectedId ? " admin-user-row-selected" : "")}
                    onClick={() => setSelectedId(u.id === selectedId ? null : u.id)}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedId(u.id === selectedId ? null : u.id);
                      }
                    }}
                    aria-selected={u.id === selectedId}
                  >
                    <td className="admin-user-email">{u.email}</td>
                    <td>
                      <StatusBadge user={u} />
                    </td>
                    <td>{formatDateTime(u.createdAt) ?? "-"}</td>
                    <td>{formatDateTime(u.lastLoginAt) ?? NOT_YET}</td>
                    <td>{u.subscriptionCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {list && list.totalPages > 1 && (
          <div className="admin-pager">
            <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
              ◀ Prev
            </button>
            <span className="muted">
              Page {list.page} / {list.totalPages}
            </span>
            <button type="button" className="btn btn-secondary btn-sm" disabled={page >= list.totalPages || loading} onClick={() => setPage((p) => p + 1)}>
              Next ▶
            </button>
          </div>
        )}
      </section>

      {selectedId !== null && (
        <section className="card admin-user-detail" aria-live="polite">
          <div className="card-title">
            User details
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelectedId(null)}>
              Close
            </button>
          </div>

          {detailError && <div className="form-error">{detailError}</div>}
          {!detail && !detailError && <div className="muted">Loading…</div>}

          {detail && (
            <>
              <dl className="edd-rows admin-detail-rows">
                <div className="edd-row">
                  <dt>E-mail</dt>
                  <dd>{detail.email}</dd>
                </div>
                <div className="edd-row">
                  <dt>Status</dt>
                  <dd>
                    <StatusBadge user={detail} />
                    {detail.disabledAt && <span className="edd-sub"> since {formatDateTime(detail.disabledAt)}</span>}
                  </dd>
                </div>
                <div className="edd-row">
                  <dt>Role</dt>
                  <dd>
                    {capitalise(detail.role)}
                    {detail.role === "admin" && <div className="edd-sub">Managed through ADMIN_EMAILS</div>}
                  </dd>
                </div>
                <div className="edd-row">
                  <dt>Created</dt>
                  <dd>{formatDateTime(detail.createdAt) ?? "-"}</dd>
                </div>
                <div className="edd-row">
                  <dt>Last sign-in</dt>
                  <dd>{formatDateTime(detail.lastLoginAt) ?? NOT_YET}</dd>
                </div>
                <div className="edd-row">
                  <dt>Notifications</dt>
                  <dd>{detail.notificationCount}</dd>
                </div>
              </dl>

              <h4 className="admin-subheading">Alert subscriptions ({detail.subscriptions.length})</h4>
              {detail.subscriptions.length === 0 ? (
                <div className="muted">None.</div>
              ) : (
                <ul className="admin-sub-list">
                  {detail.subscriptions.map((s) => (
                    <li key={s.id}>
                      <strong>{s.label}</strong>
                      <span className="edd-sub">
                        {" "}
                        · {s.type === "any" ? "Any type" : capitalise(s.type)} · min {capitalise(s.minSeverity)} · {s.radiusKm} km ·{" "}
                        {s.active ? "active" : "paused"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {actionError && <div className="form-error">{actionError}</div>}

              {canAct && (
                <div className="card-actions">
                  {detail.disabledAt ? (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={enable} disabled={actionBusy}>
                      {actionBusy ? "Working…" : "Enable account"}
                    </button>
                  ) : (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={disable} disabled={actionBusy}>
                      {actionBusy ? "Working…" : "Disable account"}
                    </button>
                  )}
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(true)} disabled={actionBusy}>
                    Delete user…
                  </button>
                </div>
              )}
              {detail.role === "admin" && <div className="muted">Admin accounts cannot be disabled or deleted here.</div>}
            </>
          )}
        </section>
      )}

      {confirmDelete && detail && (
        <DeleteDialog
          user={detail}
          busy={actionBusy}
          error={actionError}
          onCancel={() => {
            if (!actionBusy) setConfirmDelete(false);
          }}
          onConfirm={remove}
        />
      )}
    </>
  );
}
