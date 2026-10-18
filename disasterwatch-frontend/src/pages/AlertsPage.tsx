import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import type { AuthUser } from "../App";

type AlertType = "any" | "earthquake" | "flood" | "wildfire" | "storm";
type Severity = "low" | "medium" | "high";

type Subscription = {
  id: number;
  type: AlertType;
  minSeverity: Severity;
  label: string;
  centerLat: number;
  centerLng: number;
  radiusKm: number;
  active: boolean;
  createdAt: string;
};

type Props = {
  user: AuthUser | null;
  authLoading: boolean;
};

const TYPE_LABELS: Record<AlertType, string> = {
  any: "Any disaster",
  earthquake: "Earthquake",
  flood: "Flood",
  wildfire: "Wildfire",
  storm: "Storm",
};

const SEVERITY_LABELS: Record<Severity, string> = {
  low: "Low and above (every event, including not-rated ones)",
  medium: "Medium and above",
  high: "High only",
};

const CITY_PRESETS: { label: string; lat: number; lng: number }[] = [
  { label: "Warsaw", lat: 52.2297, lng: 21.0122 },
  { label: "Istanbul", lat: 41.0082, lng: 28.9784 },
  { label: "Tokyo", lat: 35.6762, lng: 139.6503 },
  { label: "Los Angeles", lat: 34.0522, lng: -118.2437 },
];

const EMPTY_FORM = {
  type: "any" as AlertType,
  minSeverity: "medium" as Severity,
  label: "",
  lat: "",
  lng: "",
  radiusKm: "300",
};

const AlertsPage = ({ user, authLoading }: Props) => {
  const [items, setItems] = useState<Subscription[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [rowError, setRowError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const res = await fetch("/api/alerts", { credentials: "include" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setListError(data?.message || "Could not load your alerts.");
        return;
      }
      setItems(Array.isArray(data?.items) ? data.items : []);
    } catch {
      setListError("Could not reach the server.");
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) load();
    else setItems([]);
  }, [user, load]);

  const applyPreset = (preset: (typeof CITY_PRESETS)[number]) => {
    setForm((f) => ({
      ...f,
      label: f.label.trim() ? f.label : preset.label,
      lat: String(preset.lat),
      lng: String(preset.lng),
    }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const lat = Number(form.lat);
    const lng = Number(form.lng);
    const radiusKm = Number(form.radiusKm);

    if (!form.label.trim()) {
      setFormError("Please give this alert a label (e.g. a city name).");
      return;
    }
    if (form.label.trim().length > 60) {
      setFormError("Label must be 60 characters or fewer.");
      return;
    }
    if (form.lat.trim() === "" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
      setFormError("Latitude must be a number between -90 and 90.");
      return;
    }
    if (form.lng.trim() === "" || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      setFormError("Longitude must be a number between -180 and 180.");
      return;
    }
    if (!Number.isInteger(radiusKm) || radiusKm < 10 || radiusKm > 5000) {
      setFormError("Radius must be a whole number between 10 and 5000 km.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          type: form.type,
          minSeverity: form.minSeverity,
          label: form.label.trim(),
          centerLat: lat,
          centerLng: lng,
          radiusKm,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setFormError(data?.message || `Request failed (${res.status}).`);
        return;
      }
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch {
      setFormError("Could not reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (sub: Subscription) => {
    setRowError(null);
    setBusyId(sub.id);
    try {
      const res = await fetch(`/api/alerts/${sub.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ active: !sub.active }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setRowError(data?.message || "Could not update the alert.");
        return;
      }
      setItems((prev) =>
        prev.map((s) => (s.id === sub.id ? { ...s, active: !sub.active } : s))
      );
    } catch {
      setRowError("Could not reach the server.");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (sub: Subscription) => {
    if (!window.confirm(`Delete the "${sub.label}" alert?`)) return;
    setRowError(null);
    setBusyId(sub.id);
    try {
      const res = await fetch(`/api/alerts/${sub.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setRowError(data?.message || "Could not delete the alert.");
        return;
      }
      setItems((prev) => prev.filter((s) => s.id !== sub.id));
    } catch {
      setRowError("Could not reach the server.");
    } finally {
      setBusyId(null);
    }
  };

  /* ---------- Signed-out view ---------- */
  if (!authLoading && !user) {
    return (
      <div className="page alerts-page">
        <header className="page-header page-header-row">
          <div>
            <h1 className="page-title">Alert center</h1>
            <p className="page-subtitle">
              Get alerts for disasters near places you care about.
            </p>
          </div>
        </header>

        <section className="alerts-signed-out">
          <h2>Create an account to get alerts for disasters near places you care about</h2>
          <p>
            Pick a location, a radius and the kinds of hazards you want to know
            about. DisasterWatch keeps your subscriptions and notifies you
            in-app when a matching event is detected.
          </p>
          <div className="alerts-signed-out-actions">
            <Link to="/signin" state={{ from: "/alerts" }} className="btn btn-primary">
              Sign in
            </Link>
            <Link to="/signup" className="btn btn-secondary">
              Create an account
            </Link>
          </div>
        </section>
      </div>
    );
  }

  /* ---------- Signed-in view ---------- */
  return (
    <div className="page alerts-page">
      <header className="page-header page-header-row">
        <div>
          <h1 className="page-title">Alert center</h1>
          <p className="page-subtitle">
            Your alert subscriptions: which hazards, how severe, and where.
          </p>
        </div>

        {user && (
          <button
            type="button"
            className={showForm ? "btn btn-secondary" : "btn btn-primary"}
            onClick={() => {
              setFormError(null);
              setShowForm((v) => !v);
            }}
          >
            {showForm ? "Close" : "+ Add alert"}
          </button>
        )}
      </header>

      {authLoading && <div className="auth-loading">Checking session…</div>}

      {showForm && (
        <section className="card">
          <div className="card-title">New alert</div>

          <form className="alerts-form" onSubmit={submit}>
            <div className="alerts-form-grid">
              <div className="form-field">
                <label>Disaster type</label>
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value as AlertType })}
                >
                  {(Object.keys(TYPE_LABELS) as AlertType[]).map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-field">
                <label>Minimum severity</label>
                <select
                  value={form.minSeverity}
                  onChange={(e) =>
                    setForm({ ...form, minSeverity: e.target.value as Severity })
                  }
                >
                  {(Object.keys(SEVERITY_LABELS) as Severity[]).map((s) => (
                    <option key={s} value={s}>
                      {SEVERITY_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-field">
                <label>Label *</label>
                <input
                  value={form.label}
                  maxLength={60}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  placeholder="e.g. Warsaw"
                />
              </div>

              <div className="form-field">
                <label>Radius (km) *</label>
                <input
                  type="number"
                  min={10}
                  max={5000}
                  step={1}
                  value={form.radiusKm}
                  onChange={(e) => setForm({ ...form, radiusKm: e.target.value })}
                />
              </div>

              <div className="form-field">
                <label>Latitude *</label>
                <input
                  type="number"
                  step="any"
                  min={-90}
                  max={90}
                  value={form.lat}
                  onChange={(e) => setForm({ ...form, lat: e.target.value })}
                  placeholder="52.2297"
                />
              </div>

              <div className="form-field">
                <label>Longitude *</label>
                <input
                  type="number"
                  step="any"
                  min={-180}
                  max={180}
                  value={form.lng}
                  onChange={(e) => setForm({ ...form, lng: e.target.value })}
                  placeholder="21.0122"
                />
              </div>
            </div>

            <div className="alerts-presets">
              <span>Quick fill:</span>
              {CITY_PRESETS.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => applyPreset(c)}
                >
                  {c.label}
                </button>
              ))}
            </div>

            {formError && <div className="form-error">{formError}</div>}

            <div className="form-actions-row">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setShowForm(false);
                  setFormError(null);
                }}
              >
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "Saving…" : "Save alert"}
              </button>
            </div>
          </form>
        </section>
      )}

      <section className="alerts-channels">
        <article className="card card-compact channel-card">
          <h3>My subscriptions</h3>
          <ul>
            <li>
              {items.length} configured, {items.filter((s) => s.active).length} active
            </li>
            <li>Up to 20 subscriptions per account</li>
          </ul>
        </article>

        <article className="card card-compact channel-card">
          <h3>Delivery channels</h3>
          <ul>
            <li>In-app notifications: active</li>
          </ul>
          {/* the free hosting sleeps between visits; a scheduled job wakes it once an hour (.github/workflows/wake.yml) */}
          <p className="channel-note">New events are checked about once an hour, so an alert can arrive up to an hour after the event is reported.</p>
        </article>
      </section>

      <section className="card">
        <div className="card-title">Configured alerts</div>

        {listError && <div className="form-error">{listError}</div>}
        {rowError && <div className="form-error">{rowError}</div>}

        {listLoading && items.length === 0 && (
          <p className="muted">Loading…</p>
        )}

        {!listLoading && !listError && items.length === 0 && (
          <p className="muted">
            No alerts yet. Use “+ Add alert” to create your first one.
          </p>
        )}

        {items.length > 0 && (
          <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Min severity</th>
                <th>Location</th>
                <th>Radius</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className={s.active ? "" : "alerts-row-paused"}>
                  <td>{TYPE_LABELS[s.type] ?? s.type}</td>
                  <td>{SEVERITY_LABELS[s.minSeverity] ?? s.minSeverity}</td>
                  <td>
                    {s.label}
                    <div className="table-sub">
                      {s.centerLat.toFixed(3)}, {s.centerLng.toFixed(3)}
                    </div>
                  </td>
                  <td>{s.radiusKm} km</td>
                  <td>
                    <button
                      type="button"
                      className={
                        s.active
                          ? "alert-status alert-status-active alert-status-btn"
                          : "alert-status alert-status-paused alert-status-btn"
                      }
                      disabled={busyId === s.id}
                      onClick={() => toggleActive(s)}
                      title={s.active ? "Click to pause" : "Click to activate"}
                    >
                      {s.active ? "Active" : "Paused"}
                    </button>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={busyId === s.id}
                      onClick={() => remove(s)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>
    </div>
  );
};

export default AlertsPage;
