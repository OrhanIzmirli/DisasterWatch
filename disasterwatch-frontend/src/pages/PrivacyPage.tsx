import { useEffect } from "react";
import { Link } from "react-router-dom";

const UPDATED = "21 October 2026";

/**
 * Plain-language privacy notice. Every statement here describes what the code
 * does; keep it in step with backend/prisma/schema.prisma and the e-mail
 * channel when either changes.
 */
export default function PrivacyPage() {
  useEffect(() => {
    const previous = document.title;
    document.title = "Privacy – DisasterWatch";
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <main className="page page-narrow privacy-page" aria-labelledby="privacy-title">
      <header className="page-header">
        <h1 id="privacy-title" className="page-title">
          Privacy
        </h1>
        <p className="page-subtitle">What DisasterWatch stores about you, who handles it, how long it is kept and how to delete it.</p>
        <p className="privacy-note">
          Plain-language summary of how the service works, last updated {UPDATED}. It is not legal advice.
        </p>
      </header>

      <section className="card privacy-section" aria-labelledby="privacy-what">
        <h2 id="privacy-what" className="privacy-heading">
          What we store
        </h2>
        <p>You can use the map, the event list and the news without an account. Nothing about you is stored for that.</p>
        <p>With an account we store:</p>
        <ul>
          <li>
            <strong>Your account:</strong> e-mail address, password (only as a one-way hash, never the password itself), when you
            signed up and when you last signed in.
          </li>
          <li>
            <strong>Your alert subscriptions:</strong> hazard type, minimum severity, the label, the centre point and the radius you
            enter. The centre point can be where you live, so we treat it as personal data.
          </li>
          <li>
            <strong>Your notifications:</strong> which event matched which subscription, its distance from your centre point, and
            when you read it.
          </li>
          <li>
            <strong>E-mail alerts, only if you turn them on:</strong> when you gave consent, whether your address is confirmed, the
            confirmation and unsubscribe codes, and a record of every e-mail we sent you (time, number of alerts, the message
            itself and whether it was delivered).
          </li>
        </ul>
        <p>
          We use no analytics, no advertising and no tracking cookies, and the database does not store IP addresses. Like any web
          server, the hosting provider's request logs and our sign-in rate limit see your IP address.
        </p>
        <p>In your browser we keep:</p>
        <ul>
          <li>a session cookie that keeps you signed in for up to 24 hours (it cannot be read by page scripts);</li>
          <li>a note whether this browser was signed in last time ("in" or "out"), so a signed-out visit does not ask the server;</li>
          <li>for the current tab only, which dashboard view you picked.</li>
        </ul>
      </section>

      <section className="card privacy-section" aria-labelledby="privacy-who">
        <h2 id="privacy-who" className="privacy-heading">
          Who handles it
        </h2>
        <ul>
          <li>
            <strong>Render</strong> hosts the website, the backend and the notification service.
          </li>
          <li>
            <strong>Neon</strong> hosts the database with everything listed above.
          </li>
          <li>
            <strong>Resend</strong> sends our e-mails. It receives your address and the content of each e-mail, and only when you
            turned e-mail alerts on.
          </li>
          <li>
            <strong>Aiven</strong> runs the message queue between our services. It carries disaster events only, no data about
            you.
          </li>
          <li>
            <strong>Esri</strong> serves the map images: your browser loads them directly, so Esri sees your IP address and the map
            area you look at.
          </li>
          <li>
            <strong>News sites:</strong> the small pictures next to some news articles load directly from the publisher's site,
            so that site sees your IP address (no referring page is sent).
          </li>
        </ul>
        <p>
          Disaster events and news come from NASA EONET, USGS, GDACS, GDELT and The Guardian. Our server fetches them; nothing about
          you is sent to these sources.
        </p>
        <p>
          The site owner can see the list of accounts (e-mail, sign-up and last sign-in time, subscriptions) to run the service,
          and can disable or delete an account. Those actions are logged; once an account is deleted, the log keeps only a
          shortened form of its address. What an admin did stays logged under the admin's own address.
        </p>
      </section>

      <section className="card privacy-section" aria-labelledby="privacy-how-long">
        <h2 id="privacy-how-long" className="privacy-heading">
          How long it is kept
        </h2>
        <ul>
          <li>
            Your account, subscriptions, notifications and e-mail records are kept until you delete them or your account. There is
            no automatic expiry at the moment.
          </li>
          <li>
            Deleting a subscription removes it; the notifications it produced stay until you delete your account. Turning e-mail
            alerts off stops the e-mails; the record of e-mails already sent stays until you delete your account.
          </li>
          <li>
            When you delete your account, the record of each e-mail we sent you is anonymised rather than removed: the message,
            your address and the link to your account are erased. Only the time and the delivery status stay, so that our daily
            sending limit keeps counting the e-mail; nothing in it points to you any more.
          </li>
          <li>
            Resend and Render keep their own logs (sent e-mails, service logs) for the limited time their plans set. The database
            provider can restore the database to an earlier point for a short window, so deleted data can remain in that history
            until the window has passed.
          </li>
        </ul>
      </section>

      <section className="card privacy-section" aria-labelledby="privacy-delete">
        <h2 id="privacy-delete" className="privacy-heading">
          How to delete it
        </h2>
        <ul>
          <li>
            <strong>Everything at once:</strong> on <Link to="/account" className="text-link">My account</Link>, choose "Delete
            account" and enter your password. Your account, subscriptions and notifications are deleted and the e-mail records
            anonymised immediately. An e-mail that was being sent at that very moment may still arrive.
          </li>
          <li>
            <strong>Single subscriptions:</strong> delete them in the <Link to="/alerts" className="text-link">Alert center</Link>.
          </li>
          <li>
            <strong>E-mails only:</strong> turn the switch off in the Alert center, or use the unsubscribe link in any of our
            e-mails.
          </li>
        </ul>
        <p>
          Questions about your data: open an issue in the{" "}
          <a className="text-link" href="https://github.com/OrhanIzmirli/DisasterWatch" rel="noreferrer" target="_blank">
            DisasterWatch repository
          </a>{" "}
          (do not post your e-mail address there).
        </p>
      </section>
    </main>
  );
}
