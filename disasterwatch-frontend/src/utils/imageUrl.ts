/**
 * Image URL for a news card, safe to load on the https site: https as is,
 * http upgraded to https (never requested over http, so no mixed-content
 * warning), anything else (data:, relative, javascript:, garbage) dropped.
 * An upgraded URL that the host does not serve over https fails to load and
 * the card hides it (see NewsPanel).
 */
export function safeImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  return parsed.protocol === "https:" ? parsed.toString() : null;
}
