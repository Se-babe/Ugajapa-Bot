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

## Deploy on Render (production)

This repo includes a [Render Blueprint](https://render.com/docs/blueprint-spec) (`render.yaml`) that provisions:

| Resource | Type | Purpose |
|----------|------|---------|
| `ugajapa-postgres` | PostgreSQL | Users, API keys, usage, billing |
| `ugajapa-bot` | Private service | NLLB fallback engine (internal only) |
| `translation-api` | Web service | Public API + dashboard |

### Steps

1. Push this repo to GitHub (already configured).
2. Open [Render Dashboard](https://dashboard.render.com/) → **New** → **Blueprint**.
3. Connect `AkademiaLimited/TransChecker-API-Server` (or your fork).
4. Review the blueprint and click **Apply**.
5. After deploy starts, open the **translation-api** service → **Environment** and set:
   - `GROQ_API_KEY` — Groq LLM + Whisper
   - `GOOGLE_API_KEY` — Google Translate, Speech, TTS
   - `ADMIN_EMAIL` — dashboard admin login
   - `ADMIN_PASSWORD` — strong production password
6. Wait for all three services to go **Live** (bot first deploy may take 10–15 min to build).
7. Open `https://translation-api-xxxx.onrender.com` — sign up, generate an API key, test translate.

### Production URL

Your live API base URL will be:

```
https://<translation-api-service-name>.onrender.com
```

Use this in Mattermost / Rocket.Chat plugin settings instead of `localhost:5000`.

### Notes

- **Starter plan** on `translation-api` keeps the service always on (no cold starts).
- **Standard plan** on `ugajapa-bot` provides 2 GB RAM for the NLLB model; upgrade to Pro if the bot OOMs.
- Postgres SSL is enabled automatically (`NODE_ENV=production`).
- Schema is applied automatically on first API startup.
- `JWT_SECRET` and `BILLING_CRON_SECRET` are auto-generated by Render.
- Optional: add a custom domain under **Settings → Custom Domains** on the translation-api service.

### Estimated monthly cost (Render)

| Service | Plan | ~Cost |
|---------|------|-------|
| translation-api | Starter | $7 |
| ugajapa-bot | Standard | $25 |
| PostgreSQL | Starter | $7 |
| **Total** | | **~$39/mo** |

Use **Free** tiers for testing only (services spin down when idle).
