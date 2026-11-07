/** GDACS reference ("WF", "1033539") from an event's GDACS source link, or null. */
export function gdacsRefFromSources(sources: { url: string }[] | undefined): { eventtype: string; eventid: string } | null {
  for (const s of sources ?? []) {
    try {
      const u = new URL(s.url);
      if (!/(^|\.)gdacs\.org$/.test(u.hostname)) continue;
      const eventtype = (u.searchParams.get("eventtype") ?? "").toUpperCase();
      const eventid = u.searchParams.get("eventid") ?? "";
      if (/^(WF|FL|TC)$/.test(eventtype) && /^\d{1,10}$/.test(eventid)) return { eventtype, eventid };
    } catch {
      /* not a URL */
    }
  }
  return null;
}
