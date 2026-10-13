import { useCallback, useEffect, useRef, useState } from "react";
import { formatDateTime } from "../utils/formatDate";

export type NotificationItem = {
  id: number;
  eventId: string;
  title: string;
  type: string;
  severity: string;
  lat: number;
  lng: number;
  distanceKm: number;
  occurredAt: string;
  createdAt: string;
  readAt: string | null;
  subscriptionLabel: string | null;
};

type Props = {
  /** Poll interval while signed in (ms). */
  pollMs?: number;
};

const TYPE_LABELS: Record<string, string> = {
  earthquake: "Earthquake",
  flood: "Flood",
  wildfire: "Wildfire",
  storm: "Storm",
};

const capitalise = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function describeDistance(n: NotificationItem) {
  const km = Math.round(n.distanceKm);
  return n.subscriptionLabel ? `${km} km from ${n.subscriptionLabel}` : `${km} km away`;
}

/**
 * Bell icon with an unread badge; opens a dropdown listing the latest
 * notifications. Rendered only while a user is signed in.
 */
const NotificationBell = ({ pollMs = 60_000 }: Props) => {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { credentials: "include" });
      if (!res.ok) {
        if (res.status !== 401) setError("Could not load notifications.");
        return;
      }
      const data = await res.json();
      setItems(Array.isArray(data?.items) ? data.items : []);
      setUnreadCount(Number(data?.unreadCount) || 0);
      setError(null);
    } catch {
      setError("Could not reach the server.");
    }
  }, []);

  // Initial load + polling while mounted (the component is only mounted when signed in)
  useEffect(() => {
    load();
    const timer = window.setInterval(load, pollMs);
    return () => window.clearInterval(timer);
  }, [load, pollMs]);

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const markRead = async (n: NotificationItem) => {
    if (n.readAt) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/notifications/${n.id}/read`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      const readAt = new Date().toISOString();
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt } : x)));
      setUnreadCount(typeof data?.unreadCount === "number" ? data.unreadCount : Math.max(0, unreadCount - 1));
    } finally {
      setBusy(false);
    }
  };

  const markAllRead = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/notifications/read-all", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) return;
      const readAt = new Date().toISOString();
      setItems((prev) => prev.map((x) => (x.readAt ? x : { ...x, readAt })));
      setUnreadCount(0);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="notif-root" ref={rootRef}>
      <button
        type="button"
        className={open ? "notif-bell active" : "notif-bell"}
        onClick={() => {
          setOpen((v) => !v);
          if (!open) load();
        }}
        aria-label={unreadCount ? `${unreadCount} unread notifications` : "Notifications"}
        aria-expanded={open}
        title="Notifications"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="notif-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>
        )}
      </button>

      {open && (
        <div className="notif-panel card" role="dialog" aria-label="Notifications">
          <div className="card-title">
            <span>Notifications</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={markAllRead}
              disabled={busy || unreadCount === 0}
            >
              Mark all read
            </button>
          </div>

          {error && <div className="form-error">{error}</div>}

          {!error && items.length === 0 && (
            <p className="muted">
              No notifications yet. They appear here when a disaster matches one of your alerts.
            </p>
          )}

          {items.length > 0 && (
            <ul className="notif-list">
              {items.map((n) => (
                <li key={n.id} className={n.readAt ? "notif-item" : "notif-item notif-item-unread"}>
                  <button
                    type="button"
                    className="notif-item-btn"
                    onClick={() => markRead(n)}
                    disabled={busy}
                    title={n.readAt ? "Read" : "Mark as read"}
                  >
                    <div className="notif-item-top">
                      <span className={`notif-tag notif-tag-${n.severity}`}>
                        {TYPE_LABELS[n.type] ?? capitalise(n.type)} · {capitalise(n.severity)}
                      </span>
                      {!n.readAt && <span className="notif-dot" aria-label="unread" />}
                    </div>
                    <div className="notif-item-title">{n.title}</div>
                    <div className="notif-item-meta">
                      {describeDistance(n)} · {formatDateTime(n.occurredAt) ?? "-"}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default NotificationBell;
