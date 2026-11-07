import { useCallback, useEffect, useState } from "react";

type KeyInfo = { prefix: string; createdAt: string; lastUsedAt: string | null };
type Session = { enabled: boolean; developer: { login: string; createdAt: string } | null; key: KeyInfo | null };

const BASE = "/api/v1";
const OUTCOMES: Record<string, string> = {
  "signed-in": "Signed in with GitHub.",
  denied: "GitHub sign-in was cancelled; nothing was stored.",
  expired: "The sign-in took too long or was opened twice. Please try again.",
  error: "GitHub sign-in failed. Please try again later.",
};

const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "never";

/** POST/DELETE to the developer routes; they need this header (cross-site forms cannot send it). */
function write(path: string, method: "POST" | "DELETE") {
  return fetch(`${BASE}${path}`, { method, headers: { "X-DW-Request": "1" } });
}

/**
 * Optional API key: sign in with GitHub, create, renew or revoke the key, sign
 * out, delete the developer account. The key is shown once, right after it is
 * created; afterwards only its prefix is known (the server keeps a hash).
 */
export default function DeveloperKeys() {
  const [session, setSession] = useState<Session | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const outcome = new URLSearchParams(window.location.search).get("developer");
    return outcome ? (OUTCOMES[outcome] ?? null) : null;
  });
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/developer/session`);
      if (!res.ok) throw new Error(String(res.status));
      setSession((await res.json()) as Session);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    // drop ?developer=… so a reload does not repeat the message
    if (typeof window !== "undefined" && window.location.search.includes("developer=")) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
    }
  }, [load]);

  async function act(run: () => Promise<Response>, done: string, after?: (res: Response) => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await run();
      if (res.status === 401) {
        setMessage("Your developer session has ended. Please sign in again.");
      } else if (!res.ok) {
        setMessage("That did not work. Please try again.");
      } else {
        if (after) await after(res);
        setMessage(done);
      }
    } catch {
      setMessage("The server could not be reached. Please try again.");
    } finally {
      setBusy(false);
      await load();
    }
  }

  const createKey = (renew: boolean) =>
    act(
      () => write("/developer/keys", "POST"),
      renew ? "New key created; the previous key no longer works." : "Key created.",
      async (res) => {
        const body = (await res.json()) as { key: string };
        setNewKey(body.key);
        setCopied(false);
      }
    );

  const revokeKey = () =>
    act(() => write("/developer/keys", "DELETE"), "Key revoked: requests with it now get 401.", async () => setNewKey(null));

  const signOut = () => act(() => write("/developer/logout", "POST"), "Signed out.", async () => setNewKey(null));

  const deleteAccount = () =>
    act(() => write("/developer/me", "DELETE"), "Developer account and keys deleted.", async () => {
      setNewKey(null);
      setConfirmDelete(false);
    });

  async function copyKey() {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="card api-section" id="developer" aria-labelledby="api-key-title">
      <h2 id="api-key-title" className="api-heading">
        Optional API key
      </h2>
      <p>
        Without a key you get 60 requests a minute per IP address. With a key, sent as <code className="api-inline-code">X-API-Key</code>, you
        get 600 a minute, counted per key. Keep the key on your server: a key in browser code is public.
      </p>

      <div aria-live="polite">{message && <p className="api-key-message">{message}</p>}</div>

      {session === null && !loadFailed && <p className="api-key-muted">Checking your developer session…</p>}
      {loadFailed && <p className="api-key-muted">The key service could not be reached; the API itself works without a key.</p>}

      {session && !session.enabled && <p className="api-key-muted">Key sign-in is not available on this server right now.</p>}

      {session?.enabled && !session.developer && (
        <>
          <p>
            Sign in with GitHub to get a key. DisasterWatch asks GitHub for no permissions and keeps only your GitHub user id and login; see{" "}
            <a href="/privacy#privacy-api-keys">Privacy</a>.
          </p>
          <a className="btn btn-primary" href={`${BASE}/auth/github`}>
            Sign in with GitHub
          </a>
        </>
      )}

      {session?.developer && (
        <>
          <p>
            Signed in as <strong>@{session.developer.login}</strong>.
          </p>

          {newKey && (
            <div className="api-key-new">
              <label htmlFor="api-key-value" className="api-example-label">
                Your new key. It is shown only now: copy it to a safe place.
              </label>
              <div className="api-key-row">
                <input id="api-key-value" className="api-key-input" readOnly value={newKey} onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="btn btn-secondary" onClick={copyKey}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}

          {session.key ? (
            <dl className="api-key-facts">
              <dt>Active key</dt>
              <dd>
                <code className="api-inline-code">{session.key.prefix}…</code>
              </dd>
              <dt>Created</dt>
              <dd>{formatDate(session.key.createdAt)}</dd>
              <dt>Last used</dt>
              <dd>{formatDate(session.key.lastUsedAt)}</dd>
            </dl>
          ) : (
            !newKey && <p className="api-key-muted">You have no active key.</p>
          )}

          <div className="api-key-actions">
            {session.key ? (
              <>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => createKey(true)}>
                  Renew key
                </button>
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={revokeKey}>
                  Revoke key
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => createKey(false)}>
                Create key
              </button>
            )}
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={signOut}>
              Sign out
            </button>
          </div>

          <div className="api-key-delete">
            {confirmDelete ? (
              <>
                <p>Delete your developer account? Your key stops working and your GitHub id and login are removed.</p>
                <div className="api-key-actions">
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={deleteAccount}>
                    Delete developer account
                  </button>
                  <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
                Delete developer account…
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
