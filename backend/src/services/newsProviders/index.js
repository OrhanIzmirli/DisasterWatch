/**
 * News providers; the service runs all of them and merges their articles.
 * Search providers (GDELT, The Guardian) implement:
 *
 *   name, label                 "gdelt" / "GDELT", "guardian" / "The Guardian"
 *   refreshIntervalMs           how often the service may refresh while this provider serves
 *   retentionMs | null          how long its articles may be kept (licence), null = no limit
 *   searchGroup(group, opts)    articles for one search-plan group (hazard type + places)
 *   searchGeneral(opts)         articles for the general disaster query
 *
 * Both return [{ title, url, domain, publishedAt, image, provider }].
 *
 * GDACS media news is per event instead: searchEvents(feedEvents) returns
 * articles already linked to their event (src/services/newsProviders/gdacs.provider.js).
 *
 * GDELT and GDACS are always present (GDACS unless DISABLE_GDACS=1). The
 * Guardian is added only when GUARDIAN_API_KEY is set.
 */
import { createGdeltProvider } from "./gdelt.provider.js";
import { createGuardianProvider } from "./guardian.provider.js";
import { createGdacsNewsProvider } from "./gdacs.provider.js";

export function createNewsProviders({ env = process.env, gdelt, gdacs, log = console } = {}) {
  const providers = [gdelt ?? createGdeltProvider()];
  const guardianKey = (env.GUARDIAN_API_KEY ?? "").trim();
  if (guardianKey) {
    providers.push(createGuardianProvider({ apiKey: guardianKey }));
  } else {
    log.log("[news] GUARDIAN_API_KEY not set: GDELT, GDACS media and the database cache only");
  }
  if (env.DISABLE_GDACS !== "1") providers.push(gdacs ?? createGdacsNewsProvider());
  return providers;
}

export { createGdeltProvider, createGuardianProvider, createGdacsNewsProvider };
