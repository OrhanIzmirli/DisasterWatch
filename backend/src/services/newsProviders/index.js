/**
 * News providers, in failover order. Every provider implements:
 *
 *   name, label                 "gdelt" / "GDELT", "guardian" / "The Guardian"
 *   refreshIntervalMs           how often the service may refresh while this provider serves
 *   retentionMs | null          how long its articles may be kept (licence), null = no limit
 *   searchGroup(group, opts)    articles for one search-plan group (hazard type + places)
 *   searchGeneral(opts)         articles for the general disaster query
 *
 * Both return [{ title, url, domain, publishedAt, image, provider }].
 *
 * GDELT is always present. The Guardian is added only when GUARDIAN_API_KEY
 * is set; without it the service runs on GDELT plus the database cache.
 */
import { createGdeltProvider } from "./gdelt.provider.js";
import { createGuardianProvider } from "./guardian.provider.js";

export function createNewsProviders({ env = process.env, gdelt, log = console } = {}) {
  const providers = [gdelt ?? createGdeltProvider()];
  const guardianKey = (env.GUARDIAN_API_KEY ?? "").trim();
  if (guardianKey) {
    providers.push(createGuardianProvider({ apiKey: guardianKey }));
  } else {
    log.log("[news] GUARDIAN_API_KEY not set: no fallback provider, GDELT + database cache only");
  }
  return providers;
}

export { createGdeltProvider, createGuardianProvider };
