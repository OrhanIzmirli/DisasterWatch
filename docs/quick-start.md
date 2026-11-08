# Quick start (Docker Compose)

Running the whole stack on your machine. Back to the [README](../README.md).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Docker with Compose v2 | Docker Desktop 4.x or Docker Engine 24+ (`docker compose version` works) | the only hard requirement |
| Git | any | |
| Node.js | `24.13.0` (`.nvmrc`) | only for running services or tests outside Docker |

Ports used on the host: **8080** (frontend), **5000** (backend), **5432** (PostgreSQL), **9092 / 29092** (Kafka), **2181** (Zookeeper). Stop anything else listening there first.

## 1) Clone and create the backend env file

```bash
git clone https://github.com/OrhanIzmirli/DisasterWatch.git
cd DisasterWatch
cp backend/.env.example backend/.env
```

`backend/.env.example` ships with a **dev-only `JWT_SECRET` placeholder** that the server accepts only with `NODE_ENV=development` (which Compose sets for the local stack); in production it is rejected, so generate a real one before any deployment (see [Environment variables](docs/operations.md#environment-variables)). To get an admin account, put your e-mail in `ADMIN_EMAILS` in `backend/.env` before registering.

## 2) Build and start

```bash
docker compose up --build
```

First start takes a few minutes (image pulls + `npm ci`). What happens:

1. `db` starts and passes its health check; `zookeeper` and `dw-kafka` start, the broker passes its health check.
2. `backend` runs `prisma db push` against the database (creates the tables on a fresh volume, no-op afterwards) and then starts the API. It logs `Backend listening on port 5000`, then `Kafka producer initialized`, then the first ingestion run.
3. `notification` connects to the database and to Kafka and logs `Notification service listening on topic: disaster-events`.
4. `frontend` serves the built app on port 8080 and proxies `/api/*` to the backend.

## 3) Open it

| URL | What you get |
|---|---|
| http://localhost:8080 | the app |
| http://localhost:8080/api/health | backend health through the Nginx proxy |
| http://localhost:8080/api/disasters | the normalized feed |
| http://localhost:5000/health | backend directly |

Register at http://localhost:8080/signup (any e-mail, password 8+ characters). Set up an alert on the Alerts page; the bell fills up when a new matching event arrives (events older than 48 hours never notify).

## Stop, reset

```bash
docker compose down          # stop, keep the database volume
docker compose down -v       # stop and delete the database volume (fresh start next time)
```
