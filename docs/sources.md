# Data sources

Back to the [README](../README.md).

DisasterWatch shows events from two **primary** sources and checks them against **confirming** sources. A confirming source never adds an event of its own: it only raises (or, by its absence, leaves unchanged) the confidence that a primary event is real ([Scoring](scoring.md)).

Licence terms were read on the official pages on 2026-11-07.

| Source | Role | Data | Licence and credit | Key | Limits and how often DisasterWatch asks |
|---|---|---|---|---|---|
| [USGS](https://earthquake.usgs.gov/earthquakes/feed/) | primary | M4.5+ earthquakes, 30 days | public domain, credit "U.S. Geological Survey" | none | summary feed, every 5 min |
| [NASA EONET](https://eonet.gsfc.nasa.gov/) | primary | wildfires, floods, severe storms, 30 days | open; name EONET, no implied NASA endorsement | none | every 5 min |
| [GDACS](https://www.gdacs.org/) | level and link | alert level of EONET events with a GDACS report | the [terms](https://www.gdacs.org/About/termofuse.aspx) give disclaimers, not a licence: only the level and the report link are used, never impact figures | none | cached 6 h per event |
| [EMSC](https://www.seismicportal.eu/) | confirming | earthquakes M4.0+, 30 days | [CC BY 4.0](https://www.seismicportal.eu/terms.html), credit "EMSC-CSEM SeismicPortal"; bulk mirroring needs permission (DisasterWatch keeps no copy beyond its in-memory cache) | none | no published limit; the 30-day window (~0.9 MB) every 6 h, otherwise only the events updated since the last request (`updatedafter`), at most every 5 min |
| [NOAA NHC](https://www.nhc.noaa.gov/) | confirming | active tropical cyclones, Atlantic and eastern/central Pacific | [public domain](https://www.weather.gov/disclaimer); no implied NOAA endorsement | none (a User-Agent identifies DisasterWatch) | `CurrentStorms.json`, at most every 10 min (it changes with each advisory, every 3–6 h) |
| [NASA FIRMS](https://www.earthdata.nasa.gov/data/tools/firms) | confirming | VIIRS (NOAA-20) active-fire detections near each EONET wildfire, 48 h, 10 km | open; whoever passes FIRMS data on acknowledges FIRMS, LANCE and ESDIS (DisasterWatch passes on counts and times only) | free `FIRMS_MAP_KEY`; off without it | 5,000 transactions / 10 min; one small area request per wildfire at most hourly (NRT data is up to 3 h late), 3 at a time, in the background |
| [GeoNames](https://www.geonames.org/) | exposure | places of 5,000 people or more (`cities5000`) | [CC BY 4.0](https://download.geonames.org/export/dump/readme.txt), credit "GeoNames" | none | downloaded once when the Docker image is built (`backend/scripts/fetch-population.mjs`); never committed, never fetched at runtime |

**Independence.** EMSC names the agency that computed each solution (`auth`). When that is the USGS (`NEIC`), the EMSC entry is the USGS solution relayed, so it shows that EMSC lists the event but is not an independent confirmation. Of the 1,729 EMSC events of the 30 days to 2026-11-07, 427 were USGS solutions and 1,302 came from EMSC itself or other agencies.

**Fetching.** Confirming sources are asked only when the feed is requested and their cache is older than its lifetime (`backend/src/services/sources`), never on a timer, so a sleeping free instance sends nothing. One request per source at a time; after a failure the source backs off (1 min doubling to 30 min) and its last answer is served for up to 6 hours. FIRMS is looked up per wildfire in the background and never delays a feed request; the key is part of its URL, so no FIRMS URL or response is logged. `DISABLE_FUSION_SOURCES=1` switches them all off; the primary feed is unaffected. `/health` reports each source's last fetch time, item count and whether it is failing (never the error text).

**Not used.** ReliefWeb (needs a pre-approved appname), Copernicus EMS (no machine-readable activation feed found).
