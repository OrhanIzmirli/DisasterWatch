import { useCallback, useEffect, useState } from "react";
import { formatDateTime } from "../../utils/formatDate";

/** Admin console > Audit log: the last 100 administrative actions, 20 per page. */

type AuditRow = {
  id: number;
  actorId: number;
  actorEmail: string;
  action: string;
  targetUserId: number | null;
  targetLabel: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

type AuditResponse = {
  items: AuditRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

const ACTION_LABELS: Record<string, string> = {
  "user.disable": "Disabled user",
  "user.enable": "Enabled user",
  "user.delete": "Deleted user",
  "disaster.create": "Created disaster entry",
};

function metadataText(m: AuditRow["metadata"]): string | null {
  if (!m) return null;
  const parts: string[] = [];
  if (typeof m.subscriptionsDeleted === "number") parts.push(`${m.subscriptionsDeleted} subscriptions removed`);
  if (typeof m.notificationsDeleted === "number") parts.push(`${m.notificationsDeleted} notifications removed`);
  if (typeof m.disasterId === "number") parts.push(`entry #${m.disasterId}`);
  if (typeof m.severity === "string") parts.push(`${m.severity} severity`);
  if (m.previouslyDisabled === true) parts.push("was already disabled");
  return parts.length ? parts.join(" · ") : null;
}

export default function AuditTab() {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AuditResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/audit${page > 1 ? `?page=${page}` : ""}`, { credentials: "include" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.message || `Request failed (${res.status})`);
      setData(json as AuditResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the audit log.");
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="card">
      <div className="card-title">
        Audit log
        <button type="button" className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      <p className="muted">Last {data?.total ?? 100} administrative actions, newest first.</p>

      {error && <div className="form-error">{error}</div>}
      {data && data.items.length === 0 && !loading && <div className="muted">No actions recorded yet.</div>}

      {data && data.items.length > 0 && (
        <div className="table-wrap">
          <table className="data-table admin-audit-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => {
                const extra = metadataText(r.metadata);
                return (
                  <tr key={r.id}>
                    <td className="admin-audit-when">{formatDateTime(r.createdAt) ?? "-"}</td>
                    <td>{r.actorEmail}</td>
                    <td>
                      <span className={`audit-action audit-action-${r.action.replace(".", "-")}`}>{ACTION_LABELS[r.action] ?? r.action}</span>
                    </td>
                    <td>
                      {r.targetLabel}
                      {extra && <div className="table-sub">{extra}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data && data.totalPages > 1 && (
        <div className="admin-pager">
          <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
            ◀ Prev
          </button>
          <span className="muted">
            Page {data.page} / {data.totalPages}
          </span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={page >= data.totalPages || loading} onClick={() => setPage((p) => p + 1)}>
            Next ▶
          </button>
        </div>
      )}
    </section>
  );
}
