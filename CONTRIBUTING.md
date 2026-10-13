# Contributing to DisasterWatch

## Branches and merging

- All work happens on a `feature/*` or `fix/*` branch. Nothing is committed directly to `main`.
- When the work is done, push the branch and stop. Merging into `main` happens only after review approval.

## Protected areas

- `disasterwatch-frontend/src/components/MapView.tsx` and the map CSS in `App.css` (`.map-panel`, `.list-panel` and related Leaflet rules) are changed only when a task explicitly asks for it. The public map and feed are served by NASA EONET + USGS and have had production regressions; treat them as a no-risk zone for unrelated work.

## UI changes

- Every pull request that changes the UI is reported with before/after screenshots of each changed page at 1440px and 390px widths.
- Screenshots are kept under `screenshots/ui-audit/` (git-ignored) and their paths are listed in the report; they are never committed.

## Commits

- Commit messages describe the change only. No attribution lines or trailers are added.
