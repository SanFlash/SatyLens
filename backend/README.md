# SatyLens Backend

FastAPI service that accepts capture uploads from the SatyLens Chrome
extension, stores them in Supabase Storage, and serves shareable viewer
pages at `/s/{share_id}`.

## Requirements

- Python 3.10+
- A Supabase project (see [`../supabase/SETUP.md`](../supabase/SETUP.md))

## Setup (Windows PowerShell)

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
copy .env.example .env
# edit .env with your Supabase URL / service-role key
uvicorn app.main:app --reload --port 8000
```

## Setup (macOS / Linux)

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
cp .env.example .env
# edit .env with your Supabase URL / service-role key
uvicorn app.main:app --reload --port 8000
```

Visit `http://localhost:8000/docs` for interactive API docs (Swagger UI).

## Running tests

```bash
pytest -v
```

Tests mock the Supabase client, so they run without live credentials —
they verify request validation, error handling, and routing.

## Endpoints

| Method | Path                  | Purpose                                   |
|--------|-----------------------|--------------------------------------------|
| GET    | `/api/health`         | Liveness check                             |
| POST   | `/api/upload`         | Upload a capture, get back a share URL     |
| GET    | `/api/share/{id}`     | JSON metadata for a share (used by the extension) |
| DELETE | `/api/share/{id}`     | Revoke a share (deletes file + row)        |
| GET    | `/s/{id}`             | Human-facing HTML viewer for a shared capture |
| POST   | `/api/session/start`  | Analytics: start a session (open, no token required) |
| POST   | `/api/session/end`    | Analytics: end a session (open, no token required) |
| POST   | `/api/events`         | Analytics: ingest a batch of events (open, no token required) |
| GET    | `/api/analytics/overview` | Aggregate KPIs (gated by `ANALYTICS_DASHBOARD_TOKEN` if set) |
| GET    | `/api/analytics/users` | List installations with usage summaries (gated) |
| GET    | `/api/analytics/user/{client_id}` | Per-user detail + activity timeline (gated) |
| GET    | `/api/analytics/features` | Feature usage breakdown (gated) |
| GET    | `/api/analytics/activity` | Recent activity feed (gated) |
| GET    | `/api/analytics/timeseries` | Daily trend data for charts (gated) |
| GET    | `/dashboard`          | Analytics admin dashboard (charts + user drill-down) |
| POST   | `/api/media/upload-url` | R2: request a presigned PUT URL for a new upload |
| POST   | `/api/media/complete` | R2: confirm an upload (verifies the object exists in R2 first) |
| GET    | `/api/media/history`  | R2: recent uploads for a given `client_id` |
| GET    | `/api/media/{id}`     | R2: detail for one upload |
| POST   | `/api/media/{id}/revoke` | R2: revoke a share link |
| POST   | `/api/media/{id}/expire` | R2: set or clear a share link's expiration |
| POST   | `/api/media/{id}/delete` | R2: delete the object and its database row |

## CORS

Only origins listed in `ALLOWED_EXTENSION_ORIGINS` (comma-separated
`chrome-extension://...` origins) and `EXTRA_CORS_ORIGINS` in `.env` are
allowed to call this API. Find your extension's ID at
`chrome://extensions` after loading it unpacked, then add
`chrome-extension://<that-id>` to `.env` and restart the server.

## Deployment (Render)

The repo includes a [`render.yaml`](../render.yaml) Blueprint, so this is
a "connect and click deploy" flow rather than manually configuring a Web
Service field by field.

### Option A — Blueprint (recommended, fastest)

1. Push this repo to GitHub (or GitLab).
2. In the Render dashboard: **New + → Blueprint**, and connect the repo.
3. Render reads `render.yaml` and provisions the service automatically —
   correct root directory (`backend/`), build command, start command
   (bound to Render's `$PORT`), Python version, and health check path
   are all already set.
4. You'll be prompted for exactly three values:
   - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — from your Supabase
     project (see [`../supabase/SETUP.md`](../supabase/SETUP.md)). Use
     the **secret** key (`sb_secret_...`) or legacy `service_role` JWT —
     never the `sb_publishable_...`/`anon` key here, it doesn't have the
     access this backend needs.
   - `ALLOWED_EXTENSION_ORIGINS` — `chrome-extension://<your-extension-id>`
     (find the ID at `chrome://extensions` after loading the extension
     unpacked; it stays stable thanks to the pinned `key` in
     `manifest.json`).
5. Click **Apply**. That's it — **you do not need to set
   `PUBLIC_BASE_URL`**. The backend detects its own
   `https://satylens-api.onrender.com`-style URL automatically (via
   Render's `RENDER_EXTERNAL_URL`) and share links work on the very first
   deploy, no redeploy-to-fix-the-URL round trip.
6. Once it's live, set the extension's API base URL (Gallery → Settings)
   to that same `https://satylens-api.onrender.com` URL so uploads route
   there instead of `localhost:8000`.

### Option B — Manual Web Service

If you'd rather not use the Blueprint:

1. **New + → Web Service**, connect the repo, set **Root Directory** to `backend`.
2. Build command: `pip install -r requirements.txt`
3. Start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
4. Health check path: `/api/health`
5. Add the same environment variables described in Option A above
   (`.env.example` documents every available one). `PUBLIC_BASE_URL`
   still auto-detects on Render either way — no need to set it manually.
6. Update the extension's API base URL (Gallery → Settings) to match
   once deployed.

### Free tier: cold starts

Render's free plan spins the service down after ~15 minutes of
inactivity and takes roughly 30-50 seconds to wake back up on the next
request. The first share link someone opens after a quiet period will
feel slow (or may even briefly show as unreachable in some browsers
before the service finishes waking); it's fast again immediately after.
If that's a problem for your use case, either upgrade to a paid plan or
have an external uptime monitor ping `/api/health` periodically to keep
the service warm.

### Never commit `.env`

Whichever option you use, all secrets go into Render's environment
variable fields — never into a committed `.env` file. `.gitignore`
already excludes `.env`; double-check that before your first push if
you've been editing it locally.
