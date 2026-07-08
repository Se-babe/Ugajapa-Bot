# UgaJapa Translation API

Central backend for **UgaJapa Connect** (Akademia Japan Co., Ltd. / Makerere Translation Group).

- **Translation API** (Node.js / Express / TypeScript) — port `5000`
- **UgaJapa Bot** (Python / FastAPI / NLLB-200) — port `8000` (internal only)
- **PostgreSQL** — `ugajapa_api` database

Plugins (Mattermost / Rocket.Chat) call this API with `X-API-Key`. They contain no translation logic.

## Quick start

### Option A — Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

First bot start downloads ~1.2 GB (NLLB-200 distilled 600M).

```bash
curl http://localhost:8000/health
curl http://localhost:5000/health
```

### Option B — Local development

```bash
# 1. PostgreSQL (or use docker compose up postgres -d)
createdb ugajapa_api   # if needed
psql "$DATABASE_URL" -f translation-api/sql/schema.sql

# 2. UgaJapa Bot
cd ugajapa-bot
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000

# 3. Translation API
cd ../translation-api
cp .env.example .env
npm install
npm run dev
```

## End-to-end smoke test

```bash
# Sign up
curl -s -X POST http://localhost:5000/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@company.com","password":"SecurePass123!","full_name":"Demo User"}'

# Login (save token)
TOKEN=$(curl -s -X POST http://localhost:5000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@company.com","password":"SecurePass123!"}' | jq -r .token)

# Generate API key (copy key_value once)
curl -s -X POST http://localhost:5000/keys/generate \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Mattermost Plugin Key"}'

# Translate
curl -s -X POST http://localhost:5000/translate \
  -H "X-API-Key: ugj_live_YOUR_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Good morning everyone","from":"en","to":"ja"}'
```

## API surface

| Method | Endpoint | Auth |
|--------|----------|------|
| POST | `/auth/signup` | — |
| POST | `/auth/login` | — |
| POST | `/auth/logout` | JWT |
| POST | `/keys/generate` | JWT |
| GET | `/keys` | JWT |
| DELETE | `/keys/:key_id` | JWT |
| POST | `/translate` | X-API-Key |
| POST | `/detect` | X-API-Key |
| GET | `/languages` | X-API-Key |
| GET | `/health` | — |
| GET | `/usage/summary` | JWT |
| GET | `/usage/history` | JWT |
| GET | `/billing/:month` | JWT |
| GET | `/billing` | JWT |
| GET | `/admin/*` | Admin JWT |

## Engine routing

| Pair | Primary | Fallback |
|------|---------|----------|
| EN ↔ JA | UgaJapa Bot | Google (if configured & quality Low) |
| EN ↔ LG | Sunbird AI | UgaJapa Bot |
| JA ↔ LG | EN pivot | UgaJapa Bot direct |
| EN ↔ ACH | UgaJapa Bot | Sunbird |
| Other | UgaJapa Bot | — |

## Plans

| Plan | Chars/month | Price |
|------|-------------|-------|
| Free | 50,000 | $0 |
| Starter | 500,000 | $9 |
| Business | 5,000,000 | $49 |
| Enterprise | Unlimited | Custom |

## Mattermost plugin settings

- **Translation API URL:** `http://localhost:5000`
- **Translation API Key:** `ugj_live_...` from `/keys/generate`

## Repository layout

```
ugajapa-translation-api/
├── translation-api/     # Node.js service
├── ugajapa-bot/         # Python NLLB bot
├── docker-compose.yml
└── README.md
```

Confidential — Akademia Japan Co., Ltd. | July 2026
