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
 *  - EMSC: data under CC BY 4.0 with credit "EMSC-CSEM SeismicPortal";
 *    https://www.seismicportal.eu/terms.html
 *  - NOAA NHC: public domain, no implied NOAA endorsement; https://www.weather.gov/disclaimer
 *  - NASA FIRMS: open sharing; third parties acknowledge FIRMS/LANCE/ESDIS
 *    (only detection counts and times are passed on); https://www.earthdata.nasa.gov/data/tools/firms
 *  - GeoNames: CC BY 4.0 (exposure term of the priority score);
 *    https://download.geonames.org/export/dump/readme.txt
 * The confirming sources and GeoNames feed the `sources`, `confidence` and
 * `priority` fields (docs/scoring.md).
 */
import { FIRMS_ACKNOWLEDGEMENT } from "../../services/sources/firms.js";

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
    Object.freeze({
      id: "emsc",
      name: "European-Mediterranean Seismological Centre (EMSC), SeismicPortal",
      url: "https://www.seismicportal.eu/",
      credit: "Credit: EMSC-CSEM SeismicPortal, https://www.seismicportal.eu",
      licence: "CC BY 4.0",
      terms: "https://www.seismicportal.eu/terms.html",
      provides: "Independent earthquake solutions that confirm USGS events (sources, confidence)",
    }),
    Object.freeze({
      id: "nhc",
      name: "NOAA National Hurricane Center",
      url: "https://www.nhc.noaa.gov/",
      credit: "Advisories: NOAA National Hurricane Center",
      licence: "U.S. public domain; no NOAA endorsement implied",
      terms: "https://www.weather.gov/disclaimer",
      provides: "Active tropical cyclones (Atlantic, eastern and central Pacific) that confirm EONET storms",
    }),
    Object.freeze({
      id: "firms",
      name: "NASA Fire Information for Resource Management System (FIRMS)",
      url: "https://earthdata.nasa.gov/firms",
      credit: FIRMS_ACKNOWLEDGEMENT,
      licence: "NASA open data; only counts and times of detections are included",
      terms: "https://www.earthdata.nasa.gov/data/tools/firms",
      provides: "Counts of satellite fire detections near EONET wildfires (sources, confidence)",
    }),
    Object.freeze({
      id: "geonames",
      name: "GeoNames",
      url: "https://www.geonames.org/",
      credit: "Population of places: GeoNames, CC BY 4.0",
      licence: "CC BY 4.0",
      terms: "https://download.geonames.org/export/dump/readme.txt",
      provides: "Population of places near an event (exposure term of the priority score)",
    }),
  ]),
  disclaimer:
    "Indicative information only, not an official warning: check your national or local authorities before acting. " +
    "DisasterWatch is not affiliated with or endorsed by NASA, USGS, NOAA, EMSC, GDACS or GeoNames. " +
    "Confidence and priority scores are DisasterWatch's own, computed by documented formulas (docs/scoring.md).",
});
