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
| POST | `/transcribe` | X-API-Key |
| POST | `/synthesize` | X-API-Key |
| POST | `/audio/translate` | X-API-Key |
| POST | `/video/translate` | X-API-Key |
| GET | `/languages` | X-API-Key |
| GET | `/health` | — |
| GET | `/usage/summary` | JWT |
| GET | `/usage/history` | JWT |
| GET | `/billing/:month` | JWT |
| GET | `/billing` | JWT |
| GET | `/admin/*` | Admin JWT |

## Engine routing

Three-tier routing (see `src/router.ts`) — UgaJapa Bot (NLLB-200) is the universal last-resort fallback in every tier:

| Tier | Language pair | Primary | Fallback | Last resort |
|------|---------------|---------|----------|--------------|
| 1 | Ugandan languages (lg, ach, nyn, teo), either side | Groq | — | UgaJapa Bot |
| 2 | Japanese, either side | Groq | Google | UgaJapa Bot |
| 3 | Everything else | Google | Groq | UgaJapa Bot |

## Voice / STT / TTS

Mattermost voice notes call these endpoints on the same Translation API URL:

| Endpoint | Purpose | Engines |
|----------|---------|---------|
| `POST /transcribe` | Audio → text + detected language | Ugandan langs → Groq Whisper; EN/JA/others → Google Speech; cross-fallback |
| `POST /audio/translate` | Transcribe + translate audio file | STT + translation router |
| `POST /video/translate` | Transcribe + translate video + SRT subtitles | Groq verbose_json segments when available |
| `POST /synthesize` | Text → MP3 read-aloud | Google Text-to-Speech |

Configure `GROQ_API_KEY` (Whisper) and `GOOGLE_API_KEY` (Speech + TTS). Optional overrides: `GOOGLE_SPEECH_API_KEY`, `GOOGLE_TTS_API_KEY`.

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

## Deploy on Render

Deploy from **[github.com/Se-babe/Ugajapa-Bot](https://github.com/Se-babe/Ugajapa-Bot)** — `render.yaml` uses the **FREE** tier by default:

| Resource | Plan | Purpose |
|----------|------|---------|
| `ugajapa-postgres` | **Free** | Users, API keys, usage, billing |
| `translation-api` | **Free** | Public API + dashboard |

Translations use **Groq + Google** (configured via API keys). The NLLB bot is **not** included on free tier (needs 2 GB+ RAM; free web services only have 512 MB).

### Quick deploy (Blueprint)

1. Open **[Deploy to Render](https://dashboard.render.com/blueprint/new?repo=https://github.com/Se-babe/Ugajapa-Bot)**.
2. Blueprint path: `render.yaml` · Branch: `main`.
3. On the review screen, fill only:
   - `GROQ_API_KEY`
   - `GOOGLE_API_KEY`
   - `ADMIN_PASSWORD`  
   (`ADMIN_EMAIL` is pre-filled.)
4. Click **Apply** — wait for **translation-api** and **ugajapa-postgres** to go Live (~5 min).
5. Open `https://translation-api-<id>.onrender.com`.

### Free tier limits

| Limit | What it means |
|-------|----------------|
| **Cold starts** | API sleeps after ~15 min idle; first request may take 30–60 s |
| **Postgres free** | Database expires after **90 days** on free — export data or upgrade before then |
| **No NLLB bot** | Groq + Google still translate all languages; bot fallback unavailable |
| **External API costs** | Groq/Google usage still billed by those providers |

### Upgrade to paid (production)

Use `render.paid.yaml` (~$39/mo) for always-on API + NLLB bot fallback:

- Blueprint path: `render.paid.yaml`
- Adds `ugajapa-bot` (Standard, 2 GB) + Starter postgres + Starter API

### After deploy

| What | Where |
|------|--------|
| **Public API URL** | translation-api service → top of page |
| **Dashboard** | Same URL in browser |
| **Admin login** | `ADMIN_EMAIL` / `ADMIN_PASSWORD` |
| **Auto-sync .env** | `RENDER_API_KEY=... node scripts/sync-render-env.mjs` |

### Architecture (free tier)

```
Internet → translation-api (free web)
                ↓
           Groq + Google APIs
                ↓
           ugajapa-postgres (free DB)
```
