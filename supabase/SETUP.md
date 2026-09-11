# Supabase Setup for SatyLens

Two things to configure in Supabase: the **database table** and the
**storage bucket**. This guide reflects the current architecture —
if you set this project up before and are still hitting "unable to
create link," read the **Troubleshooting** section near the bottom
first; it covers the single most common cause.

## 1. Create a Supabase project

1. Go to https://supabase.com/dashboard and create a new project (or use an existing one).
2. Note your **Project URL** (Settings -> API -> Project URL) — this is `SUPABASE_URL`.
3. Note your **service_role key** (Settings -> API -> Project API keys -> `service_role`, "secret"). This is `SUPABASE_SERVICE_ROLE_KEY`.
   - **Never** put this key in the Chrome extension, in frontend code, or commit it to git. It only belongs in the backend's `.env` file / hosting provider's environment variable settings. The backend generates short-lived, single-object signed URLs *using* this key server-side and hands those (never the key itself) to the browser — see "How uploads and downloads actually work" below.

## 2. Create the database table

Open **SQL Editor** in the Supabase dashboard, paste the contents of
[`supabase/schema.sql`](./schema.sql), and run it. It's idempotent
(`create table if not exists`, `add column if not exists`) — safe to
re-run any time you update this project, including if you're applying
it to a project that already has some of these columns from an earlier
version. This creates the `captures` table with:

- `share_id` — the public, unpredictable ID used in share URLs (`/s/{share_id}`)
- `storage_path` — where the file lives in Storage
- `storage_provider` — `'supabase'` (default) or `'r2'` if you've set up
  Cloudflare R2 as well (see [`../R2_SETUP.md`](../R2_SETUP.md))
- `status` — `'pending'` until an upload is verified complete, `'complete'` after
- `password_hash` — set only if the user password-protects a specific share; never the plaintext
- `expires_at` — set per-share if the user chooses an expiration, or automatically for every new share if you configure `DEFAULT_SHARE_EXPIRY_DAYS` (see step 5)
- Row Level Security enabled with a deny-all policy (the backend uses the
  service-role key, which bypasses RLS by design — this is defense in depth)

The same `schema.sql` also creates three analytics tables
(`installations`, `sessions`, `events`) used by `/api/events` and the
`/dashboard` admin dashboard — no separate step needed, running the file
once sets up everything. See the README's "Analytics" section and
[`app/services/analytics.py`](../backend/app/services/analytics.py) for
what's collected (and, just as importantly, what isn't).

## 3. Create the storage bucket

1. In the Supabase dashboard, go to **Storage**.
2. Click **New bucket**.
3. Name it exactly `captures` (matches `SUPABASE_BUCKET` in `.env.example`) — or pick your own name, just make sure `SUPABASE_BUCKET` in your `.env` matches exactly.
4. **Leave it Private.** This is different from earlier versions of this
   guide, and it's the important part: every file URL this backend
   generates for a Supabase-hosted capture is now a **signed, time-limited
   read URL** (`create_signed_url()`), generated fresh every time someone
   actually loads a share page — not the bucket's public URL. A signed URL
   works correctly on a private bucket; a public bucket adds no
   functionality here and only widens what's accessible without going
   through this backend at all. If you already made the bucket public
   under an earlier version of this guide, you can switch it back to
   private now — nothing in the current codebase depends on it being public.
5. No bucket policies are required beyond that: all uploads go through a
   signed upload URL this backend generates using the service-role key
   (which bypasses bucket policies), and all reads go through a signed
   read URL generated the same way.

## 4. File layout in the bucket

The backend stores files at:

```
captures/{year}/{month}/{share_id}.{extension}
```

e.g. `captures/2026/08/AbC12xYz9.webm`

## 5. Fill in your backend `.env`

```
SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi... (service_role secret)
SUPABASE_BUCKET=captures
PUBLIC_BASE_URL=http://localhost:8000
ALLOWED_EXTENSION_ORIGINS=chrome-extension://YOUR_EXTENSION_ID_HERE

# Optional -- see the README's Changelog for what each of these does.
# All are safe to leave unset; the defaults shown here are what you get either way.
MAX_FILE_SIZE_MB=0                  # 0 = no cap (default). Only meaningful for the
                                     # legacy /api/upload endpoint the extension no
                                     # longer calls -- the current upload flow has no
                                     # size ceiling of its own regardless of this value.
DEFAULT_SHARE_EXPIRY_DAYS=0         # 0 = new shares never expire automatically (default).
                                     # Set e.g. 30 to force every new share to expire in 30 days.
SHARE_TOKEN_SECRET=                 # Auto-generated per process if left blank -- set this
                                     # explicitly in production, or a restart invalidates
                                     # any in-flight password-protected download links.
SUPABASE_PRESIGNED_DOWNLOAD_EXPIRY=3600  # How long a signed read URL stays valid (seconds).
                                     # Regenerated fresh every page view, so this only needs
                                     # to comfortably cover one viewing session.
```

Once this is done, restart the backend (`uvicorn app.main:app --reload`)
and "Create Share Link" in the extension will start working end-to-end.

## How uploads and downloads actually work

Worth understanding if something isn't working, since both directions
follow the same underlying pattern:

**Uploading** (`POST /api/upload/signed-url` then `POST
/api/upload/complete`, called by the extension automatically): the
backend asks Supabase for a signed *upload* URL scoped to one specific
file path, using its own service-role key. The browser then PUTs the
file **directly to Supabase Storage** using that URL — this backend's
own server never receives the file bytes at all, for any file size.
Once that direct upload finishes, the backend verifies the object
actually landed (reading its real size from Supabase's own records, not
trusting the browser's word for it) and marks the share ready.

**Viewing** (`GET /s/{share_id}`): the backend asks Supabase for a
signed *read* URL for that file, again using its own service-role key,
and redirects/embeds that. This is regenerated on every page view — it
is never stored or reused — so it doesn't matter that it eventually
expires (`SUPABASE_PRESIGNED_DOWNLOAD_EXPIRY` above); revisiting the
share page just gets a fresh one.

In both directions, the service-role key itself never leaves this
backend's process — only short-lived, single-object credentials
generated from it do.

There's also a legacy `POST /api/upload` endpoint (the file body goes
straight through this server, buffered in memory, then forwarded to
Supabase) kept only for backward compatibility. The extension doesn't
call it anymore; if you're not sure which path you're on, you don't
need to worry about it — the current extension always uses the
signed-URL flow described above.

## Troubleshooting: "unable to create link" / link creates but doesn't play

**Most likely cause, if you set this project up a while ago**: your
bucket was made **public** under an earlier version of this guide, and
you're running the current backend code (which generates signed URLs
regardless of the bucket's public/private setting). This combination
still works fine — a signed URL is valid on both public and private
buckets — so a public bucket by itself isn't the problem. The actual
usual culprits, in order of likelihood:

1. **`SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` aren't set (or are
   wrong) in your deployed backend's environment.** Check
   `GET /api/health` on your deployed backend — if cloud sharing isn't
   configured, upload attempts fail with a clear 503 rather than a
   cryptic error, so this is usually easy to spot once you know to look.
2. **The bucket name doesn't match.** `SUPABASE_BUCKET` in your `.env`
   must exactly match a bucket that actually exists in your Supabase
   project (case-sensitive). A mismatch here fails at the
   `POST /api/upload/signed-url` step with an error from Supabase about
   the bucket not being found.
3. **You're running an older version of this backend** that still uses
   `get_public_url()` (pre-dating the signed-URL fix) **against a
   private bucket.** This exact combination fails silently in a
   confusing way: the upload itself can succeed, but the resulting
   "public" URL 404s or 403s for every viewer, because the bucket isn't
   actually public. Update to the current backend code (which uses
   signed URLs and works on private buckets), or, as a stopgap on old
   code, make the bucket public as the earlier version of this guide
   said to.
4. **A reverse proxy or hosting platform's own request timeout** — this
   used to be a real issue for large files on the old, since-replaced
   upload path (which routed the full file through this backend's own
   memory). The current signed-URL flow doesn't have this problem at
   all: your backend's own HTTP handlers are never in the path of the
   actual file transfer, so there's no file-size-dependent request for
   a platform timeout to catch.
5. **CORS**, if you're testing from a browser context this backend's
   `ALLOWED_EXTENSION_ORIGINS` / CORS configuration doesn't recognize.
   Check the browser console's Network tab for a CORS error specifically
   (distinct from a 404/500/503) if nothing else here explains it.

If none of these explain it, check your backend's own server logs for
the actual exception — the signed-URL endpoints raise specific,
readable error messages (bucket not found, invalid credentials, etc.)
rather than swallowing the underlying Supabase client error.
