# DisasterWatch frontend

React 19 + TypeScript + Vite single-page app: the live map (Leaflet), the disaster feed, the news panel, alert subscriptions, notifications and the admin console. The full project (backend, Kafka consumer, Docker Compose, cloud deployment) is documented in the [root README](../README.md).

## Run

The app needs the backend: all data comes from relative `/api/...` calls.

```bash
# from the repository root: backend, database and Kafka (see the root README)
docker compose up --build db dw-kafka backend

# dev server with hot reload on http://localhost:5173
cd disasterwatch-frontend
npm ci
npm run dev
```

`vite.config.ts` proxies `/api/*` to `http://localhost:5000/*`, the same rewrite Nginx does in the Docker image (`nginx/default.conf`) and a Render rewrite rule does in the cloud. The frontend reads no environment variables (`.env.example` is documentation only).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on port 5173 with the `/api` proxy |
| `npm run build` | `tsc -b` type check, then a production build into `dist/` |
| `npm run preview` | serves `dist/` on port 4173 |
| `npm run lint` | ESLint (not part of CI yet) |

Node `24.13.0` (`.nvmrc` in the repository root, `engines` in `package.json`).

## Layout

| Path | Contents |
|---|---|
| `src/App.tsx` | routes, session state, header |
| `src/pages/` | Dashboard, Alerts, Admin, Account, Sign in, Sign up |
| `src/components/` | map, event drawer, news panel, notification bell, status bar, admin tabs |
| `src/services/` | feed cache and news client |
| `src/utils/` | event text and date formatting |
| `src/App.css`, `src/index.css` | all styling (no CSS framework) |
| `public/` | `favicon.svg`, `robots.txt`, the "Powered by The Guardian" logo |
| `nginx/default.conf` | production server: SPA fallback and the `/api` proxy |

`src/components/MapView.tsx` and the map rules in `App.css` are a no-risk zone: see [CONTRIBUTING.md](../CONTRIBUTING.md).
