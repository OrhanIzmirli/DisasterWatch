# Scoring methodology

Back to the [README](../README.md) · [Data sources](sources.md)

DisasterWatch checks each event against independent sources and, from that, gives it a **confidence** and a **priority** score (0–100). Every number below is in the code (`backend/src/services/fusion`) and every score comes with the terms that produced it, so a score can always be recomputed by hand. The scores are indicative, not an official warning.

## 1. Matching events across sources

The primary event (USGS for earthquakes, NASA EONET for wildfires, floods and storms) is the anchor: it keeps its id and its fields. Observations of the confirming sources only attach to it; an observation that matches no primary event is ignored, so an event only EMSC lists is never shown.

| Type | Source | Rule |
|---|---|---|
| earthquake | EMSC | origin times at most 60 s apart (120 s when the magnitudes are within 0.5), epicentres at most 100 km apart, magnitudes within 0.8 |
| storm | NHC | the same storm name (from the EONET title), at most 1,500 km and 7 days apart; without a name, at most 300 km and 12 h apart |
| wildfire | FIRMS | satellite fire detections within 10 km of the fire in the last 48 h (low-confidence pixels left out) |
| wildfire, flood, storm | GDACS | by reference: the EONET event links to a GDACS report |

**Against false merges.**
- Only events of the same type are compared.
- One-to-one: an observation attaches to one event, and an event takes one observation per source.
- Mutual best: a pair is kept only when each is the other's closest candidate. The cost adds the time, distance and magnitude differences, each divided by its limit.
- Ambiguity guard: when the second-best candidate on either side costs less than 1.5 times the best, nothing is attached and the event is marked ambiguous for that source.
- No chains: observations are compared with primary events only, never with each other.

**Independence.** A source that relays the primary is *listed*, not *confirming*:
- an EMSC entry whose computing agency is the USGS (NEIC);
- an NHC storm when the EONET event was taken from the NHC;
- a GDACS report when the EONET event came from GDACS alone;
- fewer than three FIRMS detections.

Only confirming sources raise the confidence score fully.

**Tests.** `backend/tests/fusion-match.test.js` covers:
- every threshold just inside and just outside;
- aftershocks two minutes and 20 km apart, which keep their own entries;
- the antimeridian;
- two near-equal candidates, which leave the event ambiguous;
- one-to-one and order independence;
- a same-named storm a week later;
- the independence roles.

**Live evaluation.** `node backend/scripts/fusion-eval.mjs` matches the real sources once and writes every pair and near miss to `reports/` (git-ignored: real third-party data) for review by hand. Run on 2026-11-07 against the 729 USGS earthquakes of 30 days:
- **EMSC:** 715 were matched, 506 by an independent agency and 209 as USGS relays. None were ambiguous.
- **Spread:** origin times differed by a median of 0 s (95th percentile 3 s, maximum 40 s). Distances had a median of 5.4 km (95th percentile 21.5 km).
- **Distant pairs:** the three pairs over 50 km were remote mid-ocean and Tonga quakes 1–5 s apart with matching magnitudes.
- **Near misses:** 19 EMSC entries came within 5 min and 300 km of an unmatched quake. All 19 entries were already matched to a different quake, so one-to-one kept them from being counted twice.

## 2. Confidence (0–100): is the event real and current?

`confidence = clamp(primary + min(40, confirmations) − staleness, 0, 100)`

| Term | Points |
|---|---|
| Primary: USGS reviewed by a seismologist / USGS automatic | 60 / 45 |
| Primary: NASA EONET reported by an official agency (IRWIN, InciWeb, CAL FIRE, JTWC, NOAA NHC, FEMA, Canadian provincial fire services, NSW RFS, NIFC, CEMS) / other EONET | 45 / 40 |
| NOAA NHC: confirming / listed | +30 / +10 |
| NASA FIRMS: 3+ detections (confirming) / 1–2 (listed) | +25 / +10 |
| EMSC: independent agency (confirming) / USGS solution relayed (listed) | +20 / +5 |
| GDACS: confirming / listed | +15 / +5 |
| Confirmations together | at most +40 |
| Staleness (not for earthquakes): per full 6 h past 24 h since the event was last seen by any source (EONET, a later FIRMS detection or NHC advisory) | −1, at most −20 |

Worked examples (both are tests in `backend/tests/fusion-scores.test.js`):
- **Reviewed quake.** A reviewed USGS earthquake that EMSC confirms with its own solution scores 60 + 20 = **80**. When the EMSC entry is the USGS solution relayed, it scores 60 + 5 = 65.
- **Fire last seen 50 hours ago.** EONET took it from GDACS and FIRMS sees 7 detections near it: 40 + 25 + 5 − ⌊(50 − 24) / 6⌋ = 70 − 4 = **66**.

## 3. Priority (0–100): which events matter most now?

`priority = round(0.45 × severity + 0.35 × exposure + 0.20 × confidence)`

**Severity (0–100).** The highest of what the event has:

| Basis | Points |
|---|---|
| magnitude | M4.5 → 20, M7.5 → 100, linear |
| wind (EONET peak or current, NHC intensity) | 34 kt → 20, 137 kt → 100, linear |
| burned area | 100 ha → 20, 100,000 ha → 100, log scale |
| GDACS level | green 20, orange 60, red 100 |
| USGS PAGER level | green 20, yellow 50, orange 75, red 100 |

An event with none of these takes 70, 45, 25 or 15 from its rating (high, medium, low, unrated).

**Exposure (0–100).**
- **Formula:** `round(20 × log10(people / 1,000))`, from 0 to 100: 10,000 people → 20, 1 million → 60, 100 million → 100.
- **People counted:** those in places within a radius set by type and size. Earthquakes count within 25, 50, 100 or 200 km, at magnitude below 5, 5–6, 6–7 and 7 or more. Storms count within 200 km, floods 50 km and wildfires 25 km.
- **Data:** places come from the GeoNames `cities5000` gazetteer (CC BY 4.0), downloaded when the image is built. Sections of a city and historical places are left out.
- **Not counted:** places under about 5,000 people, so sparsely settled areas read low. It is an indicator of how many people live near the event, not an estimate of who was affected.
- **When the table is missing:** exposure is *unknown* (never 0), and the other two weights are scaled up to sum to 1.

**Worked example.** An M6.2 quake with 1 million people within 100 km and confidence 80: severity 20 + 1.7 × 80/3 = 65. So 0.45 × 65 + 0.35 × 60 + 0.20 × 80 = **66**.

Confidence carries a fifth of the weight, so an unconfirmed event cannot reach the top on severity alone.

**Live check, 2026-11-07** (GDACS off and no FIRMS key in this run):
- **Earthquakes:** median confidence 80, median priority 27.
- **Highest priority:** an M7.7 near populated Panama (79), then storms near the Indian and Mexican coasts (64–71).
- **Wildfires and floods:** confidence 20. Most EONET events in the 30-day window were last updated days ago; GDACS levels and FIRMS detections raise current ones.

## 4. On the map and in the feed

- **Markers.** A marker's size shows its priority: under 30, 30–59, 60 and over. Its outline shows its confidence: solid at 70 or more, dashed at 40–69, dotted under 40. The colour stays the event type, and the legend explains all three. Each marker's tooltip and screen-reader label say the numbers, so nothing depends on seeing the size or the dashes.
- **Filters and sort.** The feed toolbar filters list and map by minimum priority (any, 30, 60) and minimum confidence (any, 40, 70), and sorts by priority. The headline figures count every event, as they do with the search.
- **"Why these scores?"** The event drawer shows both scores and the number of independent confirmations at once. It then loads `GET /api/v1/disasters/{id}` and lists every confidence term with its points, every priority term with its value and weight, and each source that was checked. Each source shows how it matched (time and distance apart, the computing agency, satellite detections, a shared reference) and links to the source.
- **Feed size.** The dashboard feed carries only `scores: { confidence, priority, confirmations }` per event, so it stays small. The terms come from the public API when the drawer opens.

## 5. Versions and limits

Every response that carries scores names `scoreVersion`, currently 1. A change to any number above raises it and is listed in the [Changelog](../CHANGELOG.md).

**Limits.**
- The scores rank what the sources publish. They are not an official warning, and not an impact assessment.
- **Source coverage:**
  - NHC covers only the Atlantic and the eastern and central Pacific.
  - FIRMS needs a key.
  - GDACS rates only some events.
- **Exposure:** it counts residents near the event, not people affected.
