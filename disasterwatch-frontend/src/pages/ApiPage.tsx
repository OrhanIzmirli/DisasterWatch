import { lazy, Suspense, useEffect } from "react";
import { Link } from "react-router-dom";
import DeveloperKeys from "../components/DeveloperKeys";

// Swagger UI (~0.5 MB gzipped with its CSS) is its own chunk: only this page downloads it
const ApiReference = lazy(() => import("../components/ApiReference"));

const BASE_PATH = "/api/v1";

/** Base URL of the API on the site serving this page (same origin: "Try it out" calls it directly). */
function baseUrl() {
  return typeof window === "undefined" ? BASE_PATH : `${window.location.origin}${BASE_PATH}`;
}

const EXAMPLES = (base: string) => [
  { label: "High-severity events of the last 30 days", cmd: `curl "${base}/disasters?minSeverity=high"` },
  { label: "Earthquakes and storms in a box (Japan), 20 per page", cmd: `curl "${base}/disasters?type=earthquake,storm&bbox=128,30,146,46&limit=20"` },
  { label: "Next page", cmd: `curl "${base}/disasters?type=earthquake,storm&bbox=128,30,146,46&limit=20&cursor=<meta.nextCursor>"` },
  { label: "One event", cmd: `curl "${base}/disasters/usgs:us7000abcd"` },
  { label: "Only if changed since your last request (304 otherwise)", cmd: `curl -i "${base}/types" -H 'If-None-Match: <ETag>'` },
];

const FETCH_EXAMPLE = (base: string) => `const res = await fetch("${base}/disasters?type=wildfire&country=Australia");
if (res.status === 429) {
  // wait Retry-After seconds, then try again
}
const { data, meta, attribution } = await res.json();`;

/**
 * Public API page: what the API offers, its limits and attribution rules,
 * examples, and the interactive OpenAPI reference (Swagger UI, loaded lazily).
 * Every number here matches the backend (backend/src/api/v1).
 */
export default function ApiPage() {
  useEffect(() => {
    const previous = document.title;
    document.title = "Public API – DisasterWatch";
    return () => {
      document.title = previous;
    };
  }, []);

  const base = baseUrl();

  return (
    <main className="page page-narrow api-page" aria-labelledby="api-title">
      <header className="page-header">
        <h1 id="api-title" className="page-title">
          Public API
        </h1>
        <p className="page-subtitle">
          The events on the DisasterWatch map as JSON: earthquakes, wildfires, floods and severe storms of the last 30 days. Read-only, free,
          no key needed (an optional key raises the limit).
        </p>
      </header>

      <section className="card api-section" aria-labelledby="api-start">
        <h2 id="api-start" className="api-heading">
          Quick start
        </h2>
        <p>
          Base URL: <code className="api-inline-code">{base}</code>. Every response is JSON with <code className="api-inline-code">data</code>,{" "}
          <code className="api-inline-code">meta</code> and <code className="api-inline-code">attribution</code>; the full description is the{" "}
          <a href={`${BASE_PATH}/openapi.json`}>OpenAPI 3.1 document</a>.
        </p>
        <ul className="api-examples">
          {EXAMPLES(base).map((e) => (
            <li key={e.label}>
              <span className="api-example-label">{e.label}</span>
              <pre className="api-code" tabIndex={0}>
                <code>{e.cmd}</code>
              </pre>
            </li>
          ))}
        </ul>
        <p className="api-example-label">From JavaScript</p>
        <pre className="api-code" tabIndex={0}>
          <code>{FETCH_EXAMPLE(base)}</code>
        </pre>
      </section>

      <section className="card api-section" aria-labelledby="api-limits">
        <h2 id="api-limits" className="api-heading">
          Limits and caching
        </h2>
        <ul>
          <li>
            <strong>60 requests per minute per IP address</strong>, or 600 per key with an optional <a href="#developer">API key</a>. Above that
            the API answers <code className="api-inline-code">429</code> with a <code className="api-inline-code">Retry-After</code> header;{" "}
            <code className="api-inline-code">RateLimit</code> headers show what is left.
          </li>
          <li>
            <strong>Cache.</strong> The data refreshes every 5 minutes. Responses carry <code className="api-inline-code">Cache-Control</code> and an{" "}
            <code className="api-inline-code">ETag</code>: send it back in <code className="api-inline-code">If-None-Match</code> to get an empty 304.
          </li>
          <li>
            <strong>Free hosting.</strong> After about 15 quiet minutes the server sleeps; the next request can take up to a minute.
          </li>
          <li>
            <strong>Read-only.</strong> Only GET; any site may call it from the browser (CORS), no cookies are sent or set.
          </li>
        </ul>
      </section>

      <DeveloperKeys />

      <section className="card api-section" aria-labelledby="api-credit">
        <h2 id="api-credit" className="api-heading">
          Sources and attribution
        </h2>
        <ul>
          <li>
            <strong>USGS</strong> (earthquakes of magnitude 4.5 and above): public domain, credit &ldquo;U.S. Geological Survey&rdquo;.
          </li>
          <li>
            <strong>NASA EONET</strong> (wildfires, floods, severe storms): name EONET as the source and do not imply NASA endorsement. EONET
            collects events from other organisations; each event lists them under <code className="api-inline-code">links</code>.
          </li>
          <li>
            <strong>GDACS</strong>: only the alert level and the link to its report are included. GDACS impact figures are left out because its
            terms grant no licence to redistribute them.
          </li>
        </ul>
        <p>
          Each response repeats these credit lines in <code className="api-inline-code">attribution</code>. The data is indicative, not an
          official warning: check your national or local authorities before acting. See also <Link to="/privacy">Privacy</Link>.
        </p>
      </section>

      <section className="api-reference-section" aria-labelledby="api-reference">
        <h2 id="api-reference" className="api-heading api-reference-heading">
          Interactive reference
        </h2>
        <p className="api-reference-note">
          Open an endpoint, choose &ldquo;Try it out&rdquo; and &ldquo;Execute&rdquo;: the request goes to the live API and counts toward the
          limit.
        </p>
        <Suspense fallback={<p className="api-reference-loading">Loading the reference…</p>}>
          <ApiReference specUrl={`${BASE_PATH}/openapi.json`} />
        </Suspense>
      </section>
    </main>
  );
}
