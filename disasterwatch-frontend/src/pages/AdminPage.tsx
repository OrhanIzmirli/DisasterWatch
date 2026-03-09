import { useState } from "react";

type Severity = "high" | "medium" | "low";
type DisasterType = "earthquake" | "flood" | "wildfire" | "storm";

const AdminPage = () => {
  const [type, setType] = useState<DisasterType>("earthquake");
  const [location, setLocation] = useState("");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [description, setDescription] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setOk(false);
    setError(null);

    if (!location.trim() || !description.trim()) {
      setError("Location and description are required.");
      return;
    }

    setOk(true);
  };

  return (
    <div className="admin-page">
      <div className="admin-header">
        <h1 className="admin-title">Admin console</h1>
        <p className="admin-subtitle">
          Operator-only panel for creating demo disaster entries (front-end only).
        </p>
      </div>

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
            <label>Location *</label>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Warsaw, Poland"
              className={!location.trim() && error ? "field-error" : ""}
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
            <label>Description *</label>
            <textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short operational note..."
              className={!description.trim() && error ? "field-error" : ""}
            />
          </div>

          {error && <div className="auth-error">{error}</div>}
          {ok && <div className="form-success">Saved (demo). Payload ready for backend.</div>}

          <div className="form-actions">
            <button className="admin-submit-btn" type="submit">
              Save / Acknowledge
            </button>
          </div>

          <pre style={{ marginTop: "0.8rem", fontSize: "0.75rem", opacity: 0.9 }}>
{JSON.stringify(
  {
    type,
    location: location.trim(),
    severity,
    description: description.trim(),
    createdAt: new Date().toISOString(),
  },
  null,
  2
)}
          </pre>
        </form>
      </div>
    </div>
  );
};

export default AdminPage;
