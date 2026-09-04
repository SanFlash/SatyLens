# Supabase Setup for SatyLens

Two things to configure in Supabase: the **database table** and the **storage bucket**.

## 1. Create a Supabase project

1. Go to https://supabase.com/dashboard and create a new project (or use an existing one).
2. Note your **Project URL** (Settings -> API -> Project URL) — this is `SUPABASE_URL`.
3. Note your **service_role key** (Settings -> API -> Project API keys -> `service_role`, "secret"). This is `SUPABASE_SERVICE_ROLE_KEY`.
   - **Never** put this key in the Chrome extension, in frontend code, or commit it to git. It only belongs in the backend's `.env` file / hosting provider's environment variable settings.

## 2. Create the database table

Open **SQL Editor** in the Supabase dashboard, paste the contents of
[`supabase/schema.sql`](./schema.sql), and run it. This creates the
`captures` table with:

- `share_id` — the public, unpredictable ID used in share URLs (`/s/{share_id}`)
- `storage_path` — where the file lives in Storage
- `expires_at` — reserved for a future expiring-links feature (currently always `NULL`)
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
3. Name it exactly `captures` (matches `SUPABASE_BUCKET` in `.env.example`).
4. Set it to **Public** — share links need to be viewable by anyone with the
   link, without authentication, matching the MVP's no-auth sharing model
   (see "Share Link Expiration" in the product spec for the future-proofing
   already built into the schema).
5. No further bucket policies are required for the MVP: all uploads/deletes
   go through the backend using the service-role key, which bypasses bucket
   policies. Public **read** access is what makes share links work in a
   plain `<img>`/`<video>` tag.

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
MAX_FILE_SIZE_MB=100
ALLOWED_EXTENSION_ORIGINS=chrome-extension://YOUR_EXTENSION_ID_HERE
```

Once this is done, restart the backend (`uvicorn app.main:app --reload`)
and "Create Share Link" in the extension will start working end-to-end.
