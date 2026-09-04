# Google Drive Setup for SatyLens

SatyLens can upload screenshots/recordings straight to Google Drive and
generate a shareable link, as an alternative to the FastAPI/Supabase
backend (Settings → Upload destination). This uses Chrome's built-in
`chrome.identity` OAuth flow — **no client secret is ever stored in or
sent by the extension.**

## Why the extension ID matters

Google OAuth clients for Chrome extensions are locked to a specific
extension ID. Normally, loading an extension unpacked gives it a
different, random ID every time — which would break the OAuth setup
below. To avoid that, this project's `manifest.json` already includes a
`"key"` field (a public key) that pins the extension to one fixed ID:

```
dnolljemclndkekniemfdbplhajfoifc
```

As long as you don't change `manifest.json`'s `"key"` field, the
extension will load with this exact ID every time, on any machine —
so you only have to do the Google Cloud setup below once.

## 1. Create a Google Cloud project (if you don't have one)

1. Go to https://console.cloud.google.com/ and create a new project (or
   reuse an existing one).

## 2. Enable the Google Drive API

1. In the Cloud Console, go to **APIs & Services → Library**.
2. Search for **Google Drive API** and click **Enable**.

## 3. Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External** (unless you have a Google Workspace org and want
   **Internal**) and fill in the required fields (app name, support
   email).
3. Add these scopes:
   - `https://www.googleapis.com/auth/drive.file` — the app can only see
     files it creates, not your whole Drive. This is deliberate:
     SatyLens never asks for broader Drive access than it needs.
   - `https://www.googleapis.com/auth/userinfo.email` — just enough to
     show "Connected as you@example.com" in Settings.
4. While the app is in **Testing** mode, add your own Google account
   under **Test users** — otherwise Google will block sign-in.

## 4. Create the OAuth client

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth
   client ID**.
2. Application type: **Chrome Extension** (formerly "Chrome App").
3. Application ID: paste the extension ID above —
   `dnolljemclndkekniemfdbplhajfoifc`.
4. Click **Create**. Copy the generated **Client ID**
   (`....apps.googleusercontent.com`). You will **not** get (or need) a
   client secret for this application type.

## 5. Add the Client ID to the extension

Open `extension/manifest.json` and replace the placeholder:

```json
"oauth2": {
  "client_id": "YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com",
  "scopes": [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/userinfo.email"
  ]
}
```

with your real client ID, then reload the unpacked extension at
`chrome://extensions`.

## 6. Connect Google Drive in the extension

1. Open the SatyLens **Gallery** (⧉ icon in the popup).
2. Click **⚙ Settings**.
3. Under **Google Drive**, click **Connect Google Drive** and complete
   Google's consent screen.
4. Optionally pick or create a destination folder.
5. Under **Upload destination**, choose **Google Drive** (the backend
   server remains the default, so existing behavior is unaffected until
   you opt in here).
6. Click **Save**.

From now on, every **Create Share Link** button (popup, gallery, editor,
recorder) uploads to that Drive folder and returns a Drive share link
instead of going through the backend.

## What "shareable" means here

Uploaded files are set to **"Anyone with the link can view"** — that's
what makes the generated link usable by people who don't have access to
your Drive account, mirroring how Drive's own "Share" button works. If
that's not the sharing model you want, disconnect Drive and use the
backend destination instead (or adjust the permission role in
`extension/shared/drive.js`'s `uploadToDrive()`).

## Publishing to the Chrome Web Store later?

If you eventually publish this extension, the Web Store assigns its own
final extension ID once published — at that point, update the OAuth
client's Application ID to match, and update `client_id` if you rotate
the OAuth client. Everything else here still applies.
