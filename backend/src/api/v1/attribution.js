/**
 * Source credits sent with every public API v1 response (`attribution`).
 *
 * What each source's own terms say (checked 2026-11-07):
 *  - USGS: USGS-authored data is U.S. public domain; USGS asks for credit
 *    ("Credit: U.S. Geological Survey").
 *    https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits
 *  - NASA EONET: no licence is stated; its disclaimer says the metadata is for
 *    visualization and general information only and is not "official". NASA's
 *    media guidelines ask that NASA be named as the source and that no NASA
 *    endorsement be implied. EONET curates events from other organisations, so
 *    every event also lists its own sources under `links`.
 *    https://eonet.gsfc.nasa.gov/what-is-eonet
 *  - GDACS: its terms grant no redistribution licence, so the API carries only
 *    the GDACS alert level (green/orange/red) and the link to the GDACS report,
 *    never GDACS impact figures, scores, affected countries or coordinates.
 *    https://www.gdacs.org/About/termofuse.aspx
 */
export const ATTRIBUTION = Object.freeze({
  sources: Object.freeze([
    Object.freeze({
      id: "usgs",
      name: "U.S. Geological Survey, Earthquake Hazards Program",
      url: "https://earthquake.usgs.gov/",
      credit: "Credit: U.S. Geological Survey",
      licence: "U.S. public domain (USGS-authored data)",
      terms: "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
      provides: "Earthquakes of magnitude 4.5 and above",
    }),
    Object.freeze({
      id: "eonet",
      name: "NASA Earth Observatory Natural Event Tracker (EONET)",
      url: "https://eonet.gsfc.nasa.gov/",
      credit: "Event data: NASA EONET",
      licence: "Not stated by EONET; NASA material is generally not subject to U.S. copyright",
      terms: "https://eonet.gsfc.nasa.gov/what-is-eonet",
      provides: "Wildfires, floods and severe storms; each event lists the organisations it was curated from under links",
    }),
    Object.freeze({
      id: "gdacs",
      name: "Global Disaster Alert and Coordination System (GDACS)",
      url: "https://www.gdacs.org/",
      credit: "Alert level: GDACS",
      licence: "No redistribution licence stated; only the alert level and the report link are included",
      terms: "https://www.gdacs.org/About/termofuse.aspx",
      provides: "Alert level (green, orange, red) of some wildfires and floods",
    }),
  ]),
  disclaimer:
    "Indicative information only, not an official warning: check your national or local authorities before acting. " +
    "DisasterWatch is not affiliated with or endorsed by NASA, USGS or GDACS.",
});
