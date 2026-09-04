# Cloudflare R2 Setup for SatyLens

R2 is a third "Create Share Link" destination, alongside the Supabase
backend (default) and Google Drive. Screenshots and recordings upload
**directly from the browser to R2** using a short-lived presigned URL —
the file bytes never pass through the FastAPI backend, which matters
most for large screen recordings.

## 1. Create a Cloudflare account and enable R2

1. Sign up / log in at https://dash.cloudflare.com/.
2. In the sidebar, open **R2 Object Storage**. If this is your first time,
   Cloudflare will ask you to enable R2 (has a free tier).

## 2. Create a bucket

1. Click **Create bucket**.
2. Name it something specific to this project, e.g. `qa-extension-media`.
3. Location: **Automatic** is fine unless you have a reason to pin a region.
4. Leave the bucket **private** — SatyLens never needs it public. All
   access happens through short-lived presigned URLs the backend
   generates on demand (see "Why the bucket stays private" below).

## 3. Create R2 API credentials

1. In R2, go to **Manage R2 API Tokens** (or **Account API Tokens** on
   newer dashboards).
2. Create a token scoped to **Object Read & Write**, and — if the UI
   offers it — scope it to just the bucket you created above rather than
   "all buckets."
3. Copy the **Access Key ID** and **Secret Access Key**. The secret is
   shown once — save it now.
4. Note your **Account ID** (visible in the R2 dashboard's right sidebar,
   or the API token's summary page).

## 4. Configure CORS on the bucket

Browser-based presigned uploads require the bucket to explicitly allow
cross-origin `PUT` requests from the extension. In the bucket's
**Settings → CORS Policy**, add:

```json
[
  {
    "AllowedOrigins": ["chrome-extension://YOUR_EXTENSION_ID_HERE"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Why each piece is there:
- **`AllowedOrigins` is the extension's own origin, not `*`** — anyone
  else's website should not be able to use your bucket's CORS policy to
  make presigned-URL uploads on your users' behalf.
- **`PUT`** is what the direct upload uses. **`GET`/`HEAD`** support the
  presigned download/viewer flow and the backend's existence check
  (`HEAD` via `head_object`) in `POST /api/media/complete`.
- **`Content-Type`** must be allowed because the extension sends the
  exact content type the presigned URL was signed for — R2 (like S3)
  rejects a PUT whose `Content-Type` header doesn't match what was signed.
- **`ETag`** exposure isn't required for the current flow but costs
  nothing to allow and unblocks future features (e.g. verifying upload
  integrity) without another round of CORS changes.

Find your extension's ID at `chrome://extensions` after loading it
unpacked (the ID is stable across reloads because `manifest.json` ships a
pinned `key` — see the main README).

Cloudflare's own CORS documentation for R2:
https://developers.cloudflare.com/r2/buckets/cors/

## 5. Fill in the backend's `.env`

```
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=the-access-key-id-from-step-3
R2_SECRET_ACCESS_KEY=the-secret-access-key-from-step-3
R2_BUCKET_NAME=qa-extension-media
R2_PRESIGNED_UPLOAD_EXPIRY=900
R2_PRESIGNED_DOWNLOAD_EXPIRY=3600
```

Leave `R2_ENDPOINT` blank unless you have a specific reason to override
it — it's derived automatically as
`https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`.

Restart the backend after editing `.env`.

## 6. Run the database migration

R2 support reuses the existing `captures` table (rather than a parallel
schema) with a handful of new columns: `storage_provider`, `status`,
`revoked`, `view_count`, `download_count`, `client_id`. Re-run
[`supabase/schema.sql`](supabase/schema.sql) in the Supabase SQL editor —
it's written to be safe to re-run on a table that already exists (see the
migration block near the bottom of that file).

## 7. Install / reload the extension

```
chrome://extensions → Developer mode → Load unpacked → select extension/
```

If you already had the extension loaded, click the reload icon instead —
the extension ID won't change (it's pinned via `manifest.json`'s `key`).

## 8. Choose R2 as the upload destination

Open the SatyLens **Gallery → ⚙ Settings**. Under **Upload
destination**, select **Cloudflare R2**. Unlike Google Drive, there's no
separate "Connect" step — R2 has no per-user OAuth; it's simply available
whenever the backend has valid R2 credentials configured.

## 9. Test the flow

1. **Screenshot upload**: capture a screenshot, click **Create Share
   Link**. You should see upload progress, then a working
   `https://your-domain.com/s/<id>` link.
2. **Screen recording upload**: record something short, click **Create
   Share Link** from the recorder. Same expected result.
3. **Open the generated link** in a private/incognito window (no
   extension, no login) — it should render the image/video with a
   working Download button.
4. **Link expiration/revocation**: `POST /api/media/{id}/revoke` (or
   `/expire` with a `hours` body) against a share you created, then
   reload `/s/{id}` — it should show the "link unavailable" state instead
   of the media.

## Why the bucket stays private

R2 buckets can be made public, but SatyLens deliberately never does
this. Every file access — viewing a share, downloading it — goes through
a short-lived presigned URL the backend generates per request
(`R2_PRESIGNED_DOWNLOAD_EXPIRY`, default 1 hour). A presigned URL is a
bearer credential: anyone holding it can use it until it expires, same as
Cloudflare's own documentation describes
(https://developers.cloudflare.com/r2/api/tokens/). That's an acceptable
trade-off for a share link that's *meant* to be shared — but it also
means links naturally stop working after the configured expiry unless
re-fetched through `/s/{id}`, and it means the raw bucket itself is never
one misconfigured setting away from being fully public.

## What never touches the extension

`R2_SECRET_ACCESS_KEY`, `R2_ACCESS_KEY_ID`, and the R2 account ID stay in
the backend's `.env` only. The extension only ever receives a short-lived
presigned PUT URL for the one object it's uploading — never the
credentials that could generate arbitrary URLs for arbitrary objects.
