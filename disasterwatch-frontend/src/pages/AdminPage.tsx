import { useCallback, useEffect, useState } from "react";
import type { AuthUser } from "../App";

type Severity = "high" | "medium" | "low";
type DisasterType = "earthquake" | "flood" | "wildfire" | "storm";

type ManualDisaster = {
  id: number;
  type: string;
  title: string;
  severity: string | null;
  lat: number;
  lng: number;
  date: string;
  description: string | null;
  createdBy: string | null;
  createdAt: string;
};

type Props = {
  user: AuthUser | null;
};

// Default value for the datetime-local input: now, in local time, minute precision
function localDateTimeValue(d = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

const AdminPage = ({ user }: Props) => {
  const isAdmin = user?.role === "admin";

  const [type, setType] = useState<DisasterType>("earthquake");
  const [title, setTitle] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [date, setDate] = useState(localDateTimeValue());
  const [severity, setSeverity] = useState<Severity>("medium");
  const [description, setDescription] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [items, setItems] = useState<ManualDisaster[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);

  const loadManual = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const res = await fetch("/api/disasters/manual", { credentials: "include" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setListError(data?.message || "Could not load entries.");
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
    loadManual();
  }, [loadManual]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSuccess(null);
    setError(null);

    const latNum = Number(lat);
    const lngNum = Number(lng);

    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    if (lat.trim() === "" || !Number.isFinite(latNum) || latNum < -90 || latNum > 90) {
      setError("Latitude must be a number between -90 and 90.");
      return;
    }
    if (lng.trim() === "" || !Number.isFinite(lngNum) || lngNum < -180 || lngNum > 180) {
      setError("Longitude must be a number between -180 and 180.");
      return;
    }
    if (!date) {
      setError("Date is required.");
      return;
    }
    const dateIso = new Date(date);
    if (Number.isNaN(dateIso.getTime())) {
      setError("Date is invalid.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/disasters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          type,
          title: title.trim(),
          lat: latNum,
          lng: lngNum,
          date: dateIso.toISOString(),
          severity,
          description: description.trim(),
        }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(data?.message || `Request failed (${res.status}).`);
        return;
      }

      setSuccess(data?.message || "Disaster created.");
      setTitle("");
      setLat("");
      setLng("");
      setDescription("");
      setDate(localDateTimeValue());
      loadManual();
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="admin-page">
      <div className="admin-header">
        <h1 className="admin-title">Admin console</h1>
        <p className="admin-subtitle">
          Operator-only panel for creating manual disaster entries.
          {user && (
            <>
              {" "}
              Signed in as <strong>{user.email}</strong> ({user.role}).
            </>
          )}
        </p>
      </div>

      {!isAdmin ? (
        <div className="admin-form-card">
          <div className="admin-notice">
            Bu panel sadece admin rolü için. Hesabınızın rolü:{" "}
            <strong>{user?.role ?? "unknown"}</strong>.
          </div>
        </div>
      ) : (
        <div className="admin-form-card">
          <div className="admin-form-title">Create disaster entry</div>

          <form className="admin-form" onSubmit={submit}>
            <div className="form-field">
              <label>Disaster type</label>
              <select value={type} onChange={(e) => setType(e.target.value as DisasterType)}>
                <option value="earthquake">Earthquake</option>
                <option value="flood">Flood</option>
                <option value="wildfire">Wildfire</option>
                <option value="storm">Storm</option>
              </select>
            </div>

            <div className="form-field">
              <label>Title *</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. M5.2 earthquake near Izmir"
                className={!title.trim() && error ? "field-error" : ""}
              />
            </div>

            <div className="admin-form-row">
              <div className="form-field">
                <label>Latitude *</label>
                <input
                  type="number"
                  step="any"
                  min={-90}
                  max={90}
                  value={lat}
                  onChange={(e) => setLat(e.target.value)}
                  placeholder="38.42"
                />
              </div>

              <div className="form-field">
                <label>Longitude *</label>
                <input
                  type="number"
                  step="any"
                  min={-180}
                  max={180}
                  value={lng}
                  onChange={(e) => setLng(e.target.value)}
                  placeholder="27.14"
                />
              </div>
            </div>

            <div className="form-field">
              <label>Date / time *</label>
              <input
                type="datetime-local"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>

            <div className="form-field">
              <label>Severity</label>
              <div className="severity-radio-group">
                <label>
                  <input
                    type="radio"
                    name="sev"
                    value="high"
                    checked={severity === "high"}
                    onChange={() => setSeverity("high")}
                  />
                  High
                </label>
                <label>
                  <input
                    type="radio"
                    name="sev"
                    value="medium"
                    checked={severity === "medium"}
                    onChange={() => setSeverity("medium")}
                  />
                  Medium
                </label>
                <label>
                  <input
                    type="radio"
                    name="sev"
                    value="low"
                    checked={severity === "low"}
                    onChange={() => setSeverity("low")}
                  />
                  Low
                </label>
              </div>
            </div>

            <div className="form-field">
              <label>Description</label>
              <textarea
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Short operational note..."
              />
            </div>

            {error && <div className="auth-error">{error}</div>}
            {success && <div className="form-success">{success}</div>}

            <div className="form-actions">
              <button className="admin-submit-btn" type="submit" disabled={submitting}>
                {submitting ? "Saving…" : "Save entry"}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="admin-form-card">
        <div className="admin-form-title">
          Recent manual entries
          <button
            type="button"
            className="admin-refresh-btn"
            onClick={loadManual}
            disabled={listLoading}
          >
            {listLoading ? "Loading…" : "Refresh"}
          </button>
        </div>

        {listError && <div className="auth-error">{listError}</div>}

        {!listError && items.length === 0 && !listLoading && (
          <div className="admin-empty">No manual entries yet.</div>
        )}

        {items.length > 0 && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Title</th>
                  <th>Severity</th>
                  <th>Lat / Lng</th>
                  <th>Created by</th>
                </tr>
              </thead>
              <tbody>
                {items.map((d) => (
                  <tr key={d.id}>
                    <td>{new Date(d.date).toLocaleString()}</td>
                    <td>{d.type}</td>
                    <td>
                      {d.title}
                      {d.description && (
                        <div className="admin-table-desc">{d.description}</div>
                      )}
                    </td>
                    <td>{d.severity ?? "-"}</td>
                    <td>
                      {d.lat.toFixed(3)}, {d.lng.toFixed(3)}
                    </td>
                    <td>{d.createdBy ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default AdminPage;
