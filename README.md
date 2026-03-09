# 🌍⚡ DisasterWatch
A cloud-ready, real-time disaster monitoring platform powered by **NASA EONET + USGS**, built with an **event-driven microservices architecture** using **Kafka**. The system normalizes multi-source disaster data into a single model and visualizes it on an interactive map with filtering, search, and severity scoring.

Note: The project is designed to be **fully runnable on localhost** via Docker Compose (cloud deployment is optional). This makes it easy to demo in interviews without requiring cloud credentials.

---

## Features

### 1) Multi-Source Disaster Ingestion (NASA + USGS)
- Fetches global disaster data from:
  - **USGS** (Earthquakes)
  - **NASA EONET** (Wildfires, storms, floods and more)
- Normalizes heterogeneous API responses into a single schema
- Provides performance-safe limits for UI rendering (marker caps / pagination)

### 2) Interactive Dashboard (Map + Live Feed)
- Real-time map visualization with event markers
- Live feed of disasters with pagination
- KPI overview:
  - Total disasters
  - Active alerts (high severity)
  - Countries affected

### 3) Smart Filtering, Search, Sorting
- Filter by disaster type:
  - Earthquakes
  - Wildfires
  - Floods
  - Storms
- Search by city/country
- Sorting options:
  - Newest
  - Severity

### 4) Severity Scoring (LOW / MEDIUM / HIGH)
- Each event is classified by severity
- Feed badges clearly display severity
- Helps prioritize critical events

### 5) Event-Driven Architecture (Kafka)
DisasterWatch streams disaster events through Kafka to decouple ingestion from processing.

**Producer (Backend)**
- After processing/normalizing disaster data, backend publishes structured messages to Kafka topic:
  - `disaster-events`

Example message:
```json
{
  "type": "earthquake",
  "location": "Turkey",
  "severity": "high",
  "timestamp": "2026-03-08T22:25:00Z"
}

Consumer (Notification Service)

Subscribes to disaster-events

Logs received events (ready for future alert pipelines: Email/SMS/WebSocket push)

6) Dockerized Microservices (Local + Cloud-Ready)

Fully containerized:

frontend (React build served by Nginx)

backend (Node.js + Express)

db (PostgreSQL)

kafka (Confluent Kafka)

zookeeper

notification-service (Kafka consumer)

Runs locally in one command using Docker Compose

7) Bonus UI Modules (Demo-Ready)

Alerts page UI (demo)

Admin console UI (demo)

News modal UI (demo)

App Screenshots
Dashboard (Map + Feed + KPI)

API Proof (Nginx → Backend)

Health:


Disasters:




Docker Proof (All Services Up)

Kafka Proof (Consumer Receives Events)

Kafka Topics

Filtering + Search + Sorting + Severity

Earthquakes filter:


Wildfires filter:


Search by country/city:


Sort (Newest):


Sort (Severity):


Severity badges:


Map popup:


Bonus Pages

Alerts page:


Admin console:


News modal:


Tech Stack
Frontend

React

TypeScript

Vite

Leaflet (map)

Advanced filtering + scoring logic

Backend

Node.js

Express

Prisma ORM

Zod validation

REST API

KafkaJS producer

Streaming

Kafka (Confluent container)

KafkaJS (Producer / Consumer)

Consumer microservice (notification-service)

DevOps / Infra

Docker (multi-stage builds)

Docker Compose

Nginx reverse proxy

Environment-based configuration

Azure-ready containerization (optional)

Setup (Important)

This project is designed to run locally without requiring cloud deployment.

1) Create env files
cp backend/.env.example backend/.env
2) Run locally (Docker)
docker compose up --build
URLs

Frontend: http://localhost:8080

Backend health: http://localhost:5000/health

Proxy health: http://localhost:8080/api/health

Proxy disasters: http://localhost:8080/api/disasters

Kafka Demo (Send a test event)

You can send a test event into Kafka topic disaster-events:

echo "{\"type\":\"test\",\"location\":\"Warsaw\",\"severity\":\"low\",\"timestamp\":\"2026-03-08T22:25:00Z\"}" \
| docker compose exec -T dw-kafka bash -lc "kafka-console-producer --bootstrap-server localhost:9092 --topic disaster-events"

Then check consumer logs:

docker compose logs -f notification
Notes on Security

.env, .env.local, .env.docker are excluded from version control

API keys/secrets are not stored in the repository

Only .env.example is included

Future Improvements

WebSocket live broadcasting (real-time UI updates without refresh)

Notification pipeline (Email/SMS/Push) based on severity and user subscriptions

Better alert rule persistence (store alert rules in DB)

Observability: metrics + tracing (Prometheus/Grafana)

Multi-region deployment improvements for cloud

Author

Orhan Izmirli
Computer Science Student (Poland)
Project focus: Full-stack development, event-driven architecture, distributed systems, and cloud-ready deployments.