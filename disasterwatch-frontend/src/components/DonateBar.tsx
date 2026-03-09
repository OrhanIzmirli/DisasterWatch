export default function DonateBar() {
  const orgs = [
    { name: "Red Cross / Red Crescent", url: "https://www.ifrc.org/donate" },
    { name: "Doctors Without Borders (MSF)", url: "https://www.msf.org/donate" },
    { name: "UNHCR Emergency", url: "https://donate.unhcr.org/" },
  ];

  return (
    <div className="donate-bar">
      <div className="donate-title">Support relief efforts</div>

      <div className="donate-buttons">
        {orgs.map((o) => (
          <a
            key={o.name}
            className="donate-btn"
            href={o.url}
            target="_blank"
            rel="noreferrer"
          >
            Donate • {o.name}
          </a>
        ))}
      </div>

      <div className="donate-note">Donations open in a new tab.</div>
    </div>
  );
}
