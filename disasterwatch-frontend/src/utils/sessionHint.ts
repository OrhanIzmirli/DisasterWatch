/**
 * Whether this browser last had a session. The session cookie is httpOnly, so
 * the page cannot see it; without a hint every signed-out visit asks
 * /api/users/me, gets the expected 401, and the browser logs that response as
 * a console error (which page code cannot suppress).
 *
 * "in"  set on sign-in and on a successful session check
 * "out" set on sign-out and on a 401 from the session check
 * null  never checked in this browser (or storage unavailable): check once
 *
 * The hint only decides whether to ask; the server's answer always wins.
 */
export type SessionHint = "in" | "out";

const KEY = "dw.session";

export function readSessionHint(): SessionHint | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "in" || v === "out" ? v : null;
  } catch {
    return null;
  }
}

export function writeSessionHint(hint: SessionHint) {
  try {
    localStorage.setItem(KEY, hint);
  } catch {
    /* private mode / blocked storage: the session is simply checked on every load */
  }
}

/** Ask the server only when a session may exist. */
export const shouldCheckSession = (hint: SessionHint | null) => hint !== "out";
