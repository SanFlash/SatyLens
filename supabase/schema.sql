-- supabase/schema.sql
-- Run this in the Supabase SQL editor (Project -> SQL Editor -> New query)
-- for a fresh project. Creates the `captures` metadata table used by the
-- FastAPI backend (app/services/storage.py).

create table if not exists public.captures (
  id uuid primary key default gen_random_uuid(),
  share_id text not null unique,
  type text not null check (type in ('screenshot', 'recording', 'collage')),
  original_filename text not null,
  storage_path text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  duration_seconds numeric not null default 0,
  created_at timestamptz not null default now(),
  -- Reserved for a future "expiring share links" feature. NULL = never expires.
  expires_at timestamptz,
  -- Which storage backend actually holds the file bytes for this row.
  -- 'supabase' (default, existing behavior) or 'r2' (Cloudflare R2 direct
  -- upload flow — see app/routes/media.py). Google Drive uploads are not
  -- tracked in this table at all: Drive is the file's system of record
  -- for those, so there's nothing here to duplicate.
  storage_provider text not null default 'supabase' check (storage_provider in ('supabase', 'r2')),
  -- 'pending' between POST /api/media/upload-url and a verified
  -- POST /api/media/complete; 'complete' for everything else (including
  -- every existing Supabase-backend row, which skips the pending state
  -- entirely since that upload is synchronous).
  status text not null default 'complete' check (status in ('pending', 'complete')),
  revoked boolean not null default false,
  view_count integer not null default 0,
  download_count integer not null default 0,
  -- Anonymous installation id (see extension/shared/analytics.js) — lets
  -- /api/media/history scope "my recent links" without a real user-auth
  -- system. Nullable: rows created before this existed, or without a
  -- client_id supplied, just aren't scoped to any history view.
  client_id text
);

-- Fast lookups by share_id (used on every GET /api/share/{id} and /s/{id}).
create index if not exists idx_captures_share_id on public.captures (share_id);

-- Supports a future cleanup job for expired shares.
create index if not exists idx_captures_expires_at on public.captures (expires_at)
  where expires_at is not null;

-- Powers GET /api/media/history.
create index if not exists idx_captures_client_id on public.captures (client_id)
  where client_id is not null;

-- Lets a cleanup job find stuck 'pending' R2 uploads (e.g. the browser
-- tab closed mid-upload and /api/media/complete never got called).
create index if not exists idx_captures_status on public.captures (status)
  where status = 'pending';

-- Migration safety net: if you already ran an earlier version of this
-- file against an existing project, `create table if not exists` above
-- was a no-op and your table won't have the new columns yet. These
-- statements are themselves idempotent (IF NOT EXISTS), so it's always
-- safe to just re-run this whole file.
alter table public.captures add column if not exists storage_provider text not null default 'supabase';
alter table public.captures add column if not exists status text not null default 'complete';
alter table public.captures add column if not exists revoked boolean not null default false;
alter table public.captures add column if not exists view_count integer not null default 0;
alter table public.captures add column if not exists download_count integer not null default 0;
alter table public.captures add column if not exists client_id text;

-- Re-apply constraints too, in case this table predates them (e.g. the
-- 'collage' type, or the provider/status allow-lists). Drop-then-add is
-- safe to re-run any number of times.
alter table public.captures drop constraint if exists captures_type_check;
alter table public.captures add constraint captures_type_check
  check (type in ('screenshot', 'recording', 'collage'));

alter table public.captures drop constraint if exists captures_storage_provider_check;
alter table public.captures add constraint captures_storage_provider_check
  check (storage_provider in ('supabase', 'r2'));

alter table public.captures drop constraint if exists captures_status_check;
alter table public.captures add constraint captures_status_check
  check (status in ('pending', 'complete'));

-- Row Level Security: the backend talks to Supabase using the service-role
-- key, which bypasses RLS entirely, so these tables are never queried
-- directly by the extension or any anonymous client. We still enable RLS
-- and add a locked-down default policy as defense in depth, in case a
-- different (anon/public) key is ever used against this table by mistake.
alter table public.captures enable row level security;

drop policy if exists "no public access" on public.captures;
create policy "no public access" on public.captures
  for all
  using (false)
  with check (false);

-- ============================================================
-- Analytics / telemetry tables
-- ============================================================
-- `client_id` is a random UUID the extension generates and stores
-- locally (see extension/shared/analytics.js) -- it is not a Google
-- account ID, email, or any other real-world identifier. No table here
-- stores page URLs, page content, keystrokes, or precise coordinates;
-- `country` is a coarse, optional code resolved server-side from
-- infrastructure headers at request time (see
-- app/services/analytics.py:resolve_country) -- raw IP addresses are
-- never written to any of these tables.

create table if not exists public.installations (
  client_id text primary key,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  extension_version text,
  browser text,
  browser_version text,
  os text,
  device_type text,
  country text
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,
  client_id text not null references public.installations (client_id),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  extension_version text
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  session_id text not null,
  event_type text not null,
  feature text,
  action text,
  success boolean not null default true,
  error_message text,
  duration_ms integer,
  extension_version text,
  browser text,
  browser_version text,
  os text,
  device_type text,
  country text,
  created_at timestamptz not null default now()
);

create index if not exists idx_installations_last_seen on public.installations (last_seen desc);
create index if not exists idx_sessions_client_id on public.sessions (client_id);
create index if not exists idx_events_client_id on public.events (client_id);
create index if not exists idx_events_session_id on public.events (session_id);
create index if not exists idx_events_event_type on public.events (event_type);
create index if not exists idx_events_created_at on public.events (created_at desc);
create index if not exists idx_events_extension_version on public.events (extension_version);

alter table public.installations enable row level security;
alter table public.sessions enable row level security;
alter table public.events enable row level security;

drop policy if exists "no public access" on public.installations;
create policy "no public access" on public.installations for all using (false) with check (false);

drop policy if exists "no public access" on public.sessions;
create policy "no public access" on public.sessions for all using (false) with check (false);

drop policy if exists "no public access" on public.events;
create policy "no public access" on public.events for all using (false) with check (false);

