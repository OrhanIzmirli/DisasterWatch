/**
 * Country derived from a source place name, or null when it cannot be
 * derived reliably. Used for the "Countries affected" KPI, which must count
 * real countries only (no reverse geocoding, no guessing).
 *
 *   "126 km S of Kokopo, Papua New Guinea" -> "Papua New Guinea"
 *   "Fiji region"                          -> "Fiji"
 *   "Mongolia, China"                      -> "China"
 *   "Buckhorn 2, Cassia, Idaho"            -> "United States"  (US state)
 *   "North Atlantic Ocean" / "Simon"       -> null
 *
 * The country list comes from Intl.DisplayNames (ISO 3166-1 alpha-2, English
 * names) plus a few aliases the feeds use (USA, UK, Türkiye, ...).
 */

const US_STATES = new Set([
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia",
  "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland",
  "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
  "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina",
  "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
  "District of Columbia", "Puerto Rico", "Guam",
]);
const US_STATE_ABBR = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC", "PR", "GU", "VI", "MP", "AS",
]);

const ALIASES = new Map([
  ["usa", "United States"], ["us", "United States"], ["u.s.", "United States"], ["u.s.a.", "United States"], ["united states of america", "United States"],
  ["uk", "United Kingdom"], ["u.k.", "United Kingdom"], ["great britain", "United Kingdom"], ["england", "United Kingdom"], ["scotland", "United Kingdom"], ["wales", "United Kingdom"],
  ["turkiye", "Türkiye"], ["turkey", "Türkiye"],
  ["russian federation", "Russia"], ["south korea", "South Korea"], ["north korea", "North Korea"], ["iran", "Iran"], ["syria", "Syria"],
  ["vietnam", "Vietnam"], ["laos", "Laos"], ["bolivia", "Bolivia"], ["venezuela", "Venezuela"], ["tanzania", "Tanzania"], ["czech republic", "Czechia"],
  ["png", "Papua New Guinea"], ["uae", "United Arab Emirates"], ["drc", "Congo - Kinshasa"], ["ivory coast", "Côte d’Ivoire"],
  ["macedonia", "North Macedonia"], ["burma", "Myanmar (Burma)"], ["myanmar", "Myanmar (Burma)"], ["the netherlands", "Netherlands"],
  ["dominican rep.", "Dominican Republic"], ["timor-leste", "Timor-Leste"], ["east timor", "Timor-Leste"],
]);

/** English country names from the ISO 3166-1 alpha-2 space (built once). */
function buildCountryNames() {
  const names = new Map(); // lower-case -> display name
  let display = null;
  try {
    display = new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    display = null;
  }
  if (display) {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (const a of letters) {
      for (const b of letters) {
        const code = a + b;
        let name;
        try {
          name = display.of(code);
        } catch {
          continue;
        }
        if (name && name !== code && !/^[A-Z]{2}$/.test(name)) names.set(name.toLowerCase(), name);
      }
    }
  }
  return names;
}

const COUNTRY_NAMES = buildCountryNames();

function cleanToken(raw) {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s+region$/i, "")
    .replace(/^the\s+/i, "")
    .replace(/[.]+$/g, "")
    .trim();
}

/** The country for one candidate token, or null. */
export function countryFromToken(raw) {
  const token = cleanToken(raw);
  if (!token || token.length > 40 || /\d/.test(token)) return null;
  const lower = token.toLowerCase();
  if (ALIASES.has(lower)) return ALIASES.get(lower);
  if (COUNTRY_NAMES.has(lower)) return COUNTRY_NAMES.get(lower);
  if (US_STATES.has(token)) return "United States";
  if (US_STATE_ABBR.has(token.toUpperCase()) && token.length === 2) return "United States";
  return null;
}

/**
 * Country from a place string. Only the last comma-separated part is
 * trusted ("..., Papua New Guinea"); a place without commas is tried as a
 * whole ("Fiji region", "Botswana"). Anything else is null.
 */
export function countryFromPlace(place) {
  const s = String(place ?? "").trim();
  if (!s) return null;
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const direct = countryFromToken(parts[parts.length - 1]);
  if (direct) return direct;
  // "Wildfire in Botswana" (EONET titles without a comma)
  const m = s.match(/\b(?:in|near|off)\s+([A-Za-zÀ-ÿ' -]+)$/);
  if (m) return countryFromToken(m[1]);
  return null;
}
