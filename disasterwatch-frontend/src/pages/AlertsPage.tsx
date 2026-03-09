import { useState } from "react";
import type { ChangeEvent, FormEvent } from "react";

type AlertStatus = "active" | "paused";

type AlertRow = {
  id: number;
  type: string;
  region: string;
  delivery: string;
  status: AlertStatus;
};

type AlertFormState = {
  type: string;
  region: string;
  delivery: string;
  status: AlertStatus;
};

type Props = {
  isAuthed: boolean;
};

const INITIAL_ALERTS: AlertRow[] = [
  {
    id: 1,
    type: "Earthquake",
    region: "Southern Europe",
    delivery: "Email",
    status: "active",
  },
  {
    id: 2,
    type: "Flood",
    region: "Benelux",
    delivery: "SMS",
    status: "paused",
  },
  {
    id: 3,
    type: "Wildfire",
    region: "California",
    delivery: "Mobile app",
    status: "active",
  },
];

const AlertsPage = ({ isAuthed }: Props) => {
  const [alerts, setAlerts] = useState<AlertRow[]>(INITIAL_ALERTS);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const [form, setForm] = useState<AlertFormState>({
    type: "Earthquake",
    region: "",
    delivery: "Email",
    status: "active",
  });

  const [error, setError] = useState<string | null>(null);

  const openModal = () => {
    if (!isAuthed) {
      setError("You must sign in to create an alert.");
      return;
    }

    setForm({
      type: "Earthquake",
      region: "",
      delivery: "Email",
      status: "active",
    });
    setError(null);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setError(null);
  };

  const handleChange = (
    e: ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setForm((prev) => ({
      ...prev,
      [name]: value as any,
    }));
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!form.region.trim()) {
      setError("Please specify a region or country for this alert.");
      return;
    }

    const newAlert: AlertRow = {
      id: Date.now(),
      type: form.type,
      region: form.region.trim(),
      delivery: form.delivery,
      status: form.status,
    };

    setAlerts((prev) => [newAlert, ...prev]);
    closeModal();
  };

  const renderStatusChip = (status: AlertStatus) => {
    const cls =
      status === "active"
        ? "alert-status alert-status-active"
        : "alert-status alert-status-paused";

    return <span className={cls}>{status === "active" ? "Active" : "Paused"}</span>;
  };

  return (
    <div className="alerts-page">
      <header className="alerts-header">
        <div>
          <h1 className="alerts-title">Alert center</h1>
          <p className="alerts-subtitle">
            Configure user-facing alerts for earthquakes, floods, wildfires and
            severe storms.
          </p>
        </div>

        <button className="alerts-add-btn" onClick={openModal}>
          + Add alert
        </button>
      </header>

      {error && !isModalOpen && (
        <div className="news-error" style={{ marginBottom: "0.75rem" }}>
          {error}
        </div>
      )}

      {/* INFO CARDS */}
      <section className="alerts-channels">
        <article className="channel-card">
          <h3>My subscriptions</h3>
          <ul>
            <li>Earthquakes within 300 km</li>
            <li>Flood warnings for selected regions</li>
            <li>Wildfire risk alerts</li>
          </ul>
        </article>

        <article className="channel-card">
          <h3>Delivery channels</h3>
          <ul>
            <li>Email</li>
            <li>SMS</li>
            <li>Mobile app notifications</li>
          </ul>
        </article>
      </section>

      {/* TABLE */}
      <section className="alerts-table-wrapper">
        <div className="alerts-table-title">Configured alerts</div>

        <table className="alerts-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Region</th>
              <th>Delivery method</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((alert) => (
              <tr key={alert.id}>
                <td>{alert.type}</td>
                <td>{alert.region}</td>
                <td>{alert.delivery}</td>
                <td>{renderStatusChip(alert.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="alerts-footnote">
          Demo-only UI. In a real system these rules would be persisted and
          evaluated by backend services.
        </p>
      </section>

      {/* MODAL */}
      {isModalOpen && (
        <>
          <div className="alerts-modal-overlay" onClick={closeModal} />
          <div className="alerts-modal">
            <h2 className="alerts-modal-title">Create alert rule</h2>

            <form className="alerts-modal-form" onSubmit={handleSubmit}>
              <div className="form-field">
                <label>Disaster type</label>
                <select name="type" value={form.type} onChange={handleChange}>
                  <option>Earthquake</option>
                  <option>Flood</option>
                  <option>Wildfire</option>
                  <option>Storm</option>
                </select>
              </div>

              <div className="form-field">
                <label>
                  Region / country <span style={{ color: "#f97373" }}>*</span>
                </label>
                <input
                  name="region"
                  value={form.region}
                  onChange={handleChange}
                  placeholder="e.g. Central Europe, Tokyo"
                  className={error ? "field-error" : ""}
                />
                {error && <span className="error-text">{error}</span>}
              </div>

              <div className="form-field">
                <label>Delivery method</label>
                <select
                  name="delivery"
                  value={form.delivery}
                  onChange={handleChange}
                >
                  <option>Email</option>
                  <option>SMS</option>
                  <option>Mobile app</option>
                </select>
              </div>

              <div className="form-field">
                <label>Status</label>
                <div className="severity-radio-group">
                  <label>
                    <input
                      type="radio"
                      name="status"
                      value="active"
                      checked={form.status === "active"}
                      onChange={handleChange}
                    />
                    Active
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="status"
                      value="paused"
                      checked={form.status === "paused"}
                      onChange={handleChange}
                    />
                    Paused
                  </label>
                </div>
              </div>

              <div className="alerts-modal-actions">
                <button
                  type="button"
                  className="alerts-modal-btn alerts-modal-btn-secondary"
                  onClick={closeModal}
                >
                  Cancel
                </button>
                <button type="submit" className="alerts-modal-btn">
                  Save alert
                </button>
              </div>
            </form>
          </div>
        </>
      )}
    </div>
  );
};

export default AlertsPage;
