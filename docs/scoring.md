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
- **Near misses:** 19 EMSC entries came within 5 min and 300 km of an unmatched quake. On review they were either aftershocks outside the rule or entries already taken by a closer quake.

Confidence and priority scores: section 2 and 3 follow with the scores step.
