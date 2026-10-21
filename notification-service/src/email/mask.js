/**
 * Logs and stored errors never carry an e-mail address: addresses are
 * masked ("someone@example.com" -> "som***@example.com", the same rule as
 * the backend's admin audit log).
 */
export function maskEmail(email) {
  const s = String(email ?? "");
  const at = s.lastIndexOf("@");
  if (at <= 0) return s ? `${s.slice(0, 3)}***` : "";
  return `${s.slice(0, Math.min(3, at))}***${s.slice(at)}`;
}

const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Masks every address in a free-text message (provider errors quote the recipient) and caps its length. */
export function scrubText(text, max = 300) {
  return String(text ?? "")
    .replace(ADDRESS, (m) => maskEmail(m))
    .slice(0, max);
}
