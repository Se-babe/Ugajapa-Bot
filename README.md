# UgaJapa Translation API

Central backend for **UgaJapa Connect** (Akademia Japan Co., Ltd. / Makerere Translation Group).

- **Translation API** (Node.js / Express / TypeScript) — port `5000`
- **UgaJapa Bot** (Python / FastAPI / NLLB-200) — port `8000` (internal only)
- **PostgreSQL** — `ugajapa_api` database
- **Web portal** — `http://localhost:5000/` (signup, keys, usage, test translate)

Plugins (**Mattermost** in `../MATTERMOST_PLUGIN`) call this API with per-user API keys. They contain no Google keys or translation engines.

## Quick start

### Option A — Docker Compose (API + portal only, fast)

```bash
cp .env.example .env
docker compose up --build
```

This starts **PostgreSQL + Translation API** only (~1–2 min). Open http://localhost:5000/

The ML bot is optional and heavy (~1 GB download). Add it when you need local NLLB translation:

```bash
docker compose --profile bot up --build
```

Or everything explicitly:

```bash
docker compose --profile full up --build
```

```bash
curl http://localhost:8000/health
curl http://localhost:5000/health
```

Open the portal: http://localhost:5000/

### Option B — Local development

```bash
createdb ugajapa_api   # if needed
psql "$DATABASE_URL" -f translation-api/sql/schema.sql

cd ugajapa-bot && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000

cd ../translation-api && cp .env.example .env
npm install && npm run dev
```

## Architecture

```
Mattermost Plugin  ──POST /translate + X-API-Key──►  Translation API (:5000)
Web portal         ──JWT auth / keys / dashboard──►       │
                                                          ├──► UgaJapa Bot (:8000)
                                                          ├──► Sunbird AI (optional)
                                                          └──► Google Translate (optional fallback)
```

## API surface

### Public REST API v1 (plugins & integrations)

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/v1/translate` | API key | Translate + quality + usage |
| GET | `/v1/languages` | API key | Supported languages |
| GET | `/v1/usage` | API key | Current period character usage |
| POST | `/v1/feedback` | API key | Rate a translation by `requestId` |

Auth: `X-API-Key: ugj_live_…` or `Authorization: Bearer ugj_live_…`

**Standard v1 response:**

```json
{
  "translation": "Translated text",
  "sourceLang": "en",
  "targetLang": "ja",
  "engine": "ugajapa-bot",
  "usage": { "sourceCharacters": 42, "billedCharacters": 42 },
  "quality": {
    "score": 84,
    "label": "Good",
    "signals": ["length_ratio_ok", "backtranslation_strong"]
  },
  "requestId": "req_abc123"
}
```

### Mattermost plugin routes (legacy-compatible)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/translate` | Full translate + quality |
| POST | `/translate/deliver` | Forward translation only (fast UI delivery) |
| POST | `/translate/evaluate` | Quality on existing origin/translated pair |
| POST | `/detect` | Heuristic language detection |
| GET | `/languages` | Supported languages |

Plugin response includes flat scores (`score`, `semantic_score`, `quality_score`) plus nested `quality` and `requestId`.

### Portal / account API

| Method | Endpoint | Auth |
|--------|----------|------|
| POST | `/auth/signup`, `/auth/register` | — |
| POST | `/auth/login` | — |
| POST | `/auth/logout` | JWT |
| POST | `/keys/generate` | JWT |
| GET | `/keys` | JWT |
| DELETE | `/keys/:key_id` | JWT |
| GET | `/dashboard/usage` | JWT |
| GET | `/dashboard/invoices` | JWT |
| GET | `/usage/summary`, `/billing` | JWT |
| GET | `/admin/*` | Admin JWT |

## End-to-end smoke test

```bash
# Sign up
curl -s -X POST http://localhost:5000/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@company.com","password":"SecurePass123!","full_name":"Demo User"}'

# Login
TOKEN=$(curl -s -X POST http://localhost:5000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@company.com","password":"SecurePass123!"}' | jq -r .token)

# Generate API key
curl -s -X POST http://localhost:5000/keys/generate \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Mattermost Plugin Key"}'

# v1 translate
curl -s -X POST http://localhost:5000/v1/translate \
  -H "X-API-Key: ugj_live_YOUR_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Good morning everyone","sourceLang":"en","targetLang":"ja"}'

# Mattermost-style deliver + evaluate
curl -s -X POST http://localhost:5000/translate/deliver \
  -H "X-API-Key: ugj_live_YOUR_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello team","from":"en","to":"ja"}'
```

## Mattermost plugin settings

In `../MATTERMOST_PLUGIN/mattermost-plugin-translation`:

| Setting | Value |
|---------|-------|
| **Translation API URL** | `http://localhost:5000` (or your deployed host) |
| **Translation API Key** | `ugj_live_…` from portal or `/keys/generate` |
| **STT API URL** | Separate media service (not in this repo yet) |

The plugin uses `/translate`, `/translate/deliver`, and `/translate/evaluate` — all supported here.

## Quality evaluation

Every translation response includes server-side quality metadata:

- **Phase 1 (implemented):** Rule-based scoring ported from `TranslationAccuracyService` (length ratio, target script, unchanged text, etymology dumps) blended with back-translation Levenshtein + word-overlap signals
- Labels: `High` | `Good` | `Fair` | `Low` (0–100 score)
- Optional Google fallback when quality is Low on EN↔JA

## Billing & metering

- Unit: source characters (`[...text].length`)
- Per-request logging in `usage_records` with `request_id`
- Monthly cron generates bills; Stripe integration is planned (Phase 3)

| Plan | Chars/month | Price |
|------|-------------|-------|
| Free | 50,000 | $0 |
| Starter | 500,000 | $9 + overage |
| Business | 5,000,000 | $49 + overage |
| Enterprise | Unlimited | Custom |

## Engine routing

| Pair | Primary | Fallback |
|------|---------|----------|
| EN ↔ JA | UgaJapa Bot | Google (if quality Low) |
| EN ↔ LG | Sunbird AI | UgaJapa Bot |
| JA ↔ LG | EN pivot | UgaJapa Bot direct |
| EN ↔ ACH | UgaJapa Bot | Sunbird |
| Other | UgaJapa Bot | — |

## Repository layout

```
Ugajapa-Bot/
├── translation-api/     # Node.js Translation API + portal
├── ugajapa-bot/         # Python NLLB bot
├── docker-compose.yml
└── README.md
```

Sibling repos: `../MATTERMOST_PLUGIN` (Mattermost plugin), `../ROCKECT_CHAT` (legacy Rocket.Chat).

Confidential — Akademia Japan Co., Ltd. | July 2026
