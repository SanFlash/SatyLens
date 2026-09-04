"""
app/services/analytics.py
Data access + aggregation for the analytics system. Reuses the same
Supabase client pattern as app/services/storage.py.

Aggregation is done in Python over time-windowed queries (e.g. "events in
the last 30 days") rather than Postgres materialized views -- the simplest
thing that works for an extension-analytics workload. If event volume ever
gets large enough for this to matter, the natural next step is to replace
these functions' bodies with calls to Postgres RPC functions / scheduled
rollups without changing any of the route signatures above them.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Optional

from app.services.storage import get_supabase_client

# Headers some CDNs/edge proxies attach with a coarse, IP-derived country
# code. We only ever read these -- the raw request IP is never stored.
COUNTRY_HEADERS = ("cf-ipcountry", "x-country-code", "x-appengine-country")


def resolve_country(headers) -> Optional[str]:
    for h in COUNTRY_HEADERS:
        value = headers.get(h)
        if value and value.upper() != "XX":
            return value.upper()
    return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _window_start_iso(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


# ============================== Ingestion ==============================

def upsert_installation(ctx: dict, country: Optional[str]) -> None:
    """Creates the installation row on first sight, otherwise just bumps
    last_seen and the latest version/browser/os info."""
    client = get_supabase_client()
    now = _now_iso()
    existing = (
        client.table("installations").select("client_id").eq("client_id", ctx["client_id"]).limit(1).execute()
    )
    row = {
        "client_id": ctx["client_id"],
        "last_seen": now,
        "extension_version": ctx.get("extension_version"),
        "browser": ctx.get("browser"),
        "browser_version": ctx.get("browser_version"),
        "os": ctx.get("os"),
        "device_type": ctx.get("device_type"),
    }
    if country:
        row["country"] = country

    if existing.data:
        client.table("installations").update(row).eq("client_id", ctx["client_id"]).execute()
    else:
        row["first_seen"] = now
        client.table("installations").insert(row).execute()


def start_session(session_id: str, ctx: dict, country: Optional[str]) -> None:
    upsert_installation(ctx, country)
    client = get_supabase_client()
    client.table("sessions").insert(
        {
            "session_id": session_id,
            "client_id": ctx["client_id"],
            "started_at": _now_iso(),
            "ended_at": None,
            "extension_version": ctx.get("extension_version"),
        }
    ).execute()


def end_session(session_id: str) -> bool:
    client = get_supabase_client()
    result = (
        client.table("sessions")
        .update({"ended_at": _now_iso()})
        .eq("session_id", session_id)
        .is_("ended_at", "null")
        .execute()
    )
    return bool(result.data)


def insert_events(events: list[dict], country: Optional[str]) -> int:
    client = get_supabase_client()
    rows = []
    seen_clients: dict[str, dict] = {}
    for e in events:
        row = dict(e)
        row.setdefault("created_at", row.pop("timestamp", None) or _now_iso())
        if country:
            row["country"] = country
        rows.append(row)
        seen_clients[e["client_id"]] = e

    if rows:
        client.table("events").insert(rows).execute()

    # Keep installations.last_seen fresh without requiring a separate
    # session-start call for every burst of events.
    for client_id, ctx in seen_clients.items():
        upsert_installation(ctx, country)

    return len(rows)


# ============================== Reporting ==============================

_CAPTURE_EVENTS = {"SCREENSHOT_CAPTURED"}
_RECORDING_EVENTS = {"SCREEN_RECORDING_STOPPED"}
_UPLOAD_EVENTS = {"SCREENSHOT_UPLOADED", "SCREEN_RECORDING_UPLOADED"}
_LINK_EVENTS = {"LINK_GENERATED"}
_COLLAGE_EVENTS = {"COLLAGE_CREATED"}


def _fetch_events_window(days: int, select: str = "*") -> list[dict]:
    client = get_supabase_client()
    result = (
        client.table("events")
        .select(select)
        .gte("created_at", _window_start_iso(days))
        .execute()
    )
    return result.data or []


def get_overview(days: int = 30) -> dict:
    client = get_supabase_client()

    total_users_res = client.table("installations").select("client_id", count="exact").execute()
    total_users = total_users_res.count or 0

    def distinct_active_clients(days_back: int) -> int:
        rows = client.table("events").select("client_id").gte("created_at", _window_start_iso(days_back)).execute()
        return len({r["client_id"] for r in (rows.data or [])})

    active_users = {
        "daily": distinct_active_clients(1),
        "weekly": distinct_active_clients(7),
        "monthly": distinct_active_clients(30),
    }

    sessions_res = client.table("sessions").select("session_id", count="exact").execute()
    total_sessions = sessions_res.count or 0

    events = _fetch_events_window(days, select="event_type,feature,success,extension_version")

    type_counts = Counter(e["event_type"] for e in events)
    feature_counts = Counter(e["feature"] for e in events if e.get("feature"))
    version_counts = Counter(e.get("extension_version") or "unknown" for e in events)
    failed = sum(1 for e in events if e.get("success") is False)

    screenshots_captured = sum(type_counts[t] for t in _CAPTURE_EVENTS)
    screen_recordings = sum(type_counts[t] for t in _RECORDING_EVENTS)
    uploads = sum(type_counts[t] for t in _UPLOAD_EVENTS)
    links_generated = sum(type_counts[t] for t in _LINK_EVENTS)
    collages_created = sum(type_counts[t] for t in _COLLAGE_EVENTS)

    most_used_features = [
        {"feature": feature, "count": count} for feature, count in feature_counts.most_common(10)
    ]
    extension_versions = [
        {"version": version, "count": count} for version, count in version_counts.most_common(20)
    ]

    return {
        "total_users": total_users,
        "active_users": active_users,
        "total_sessions": total_sessions,
        "screenshots_captured": screenshots_captured,
        "screen_recordings": screen_recordings,
        "uploads": uploads,
        "links_generated": links_generated,
        "collages_created": collages_created,
        "most_used_features": most_used_features,
        "failed_operations": failed,
        "extension_versions": extension_versions,
    }


def list_users(limit: int = 50, offset: int = 0) -> list[dict]:
    client = get_supabase_client()
    installs = (
        client.table("installations")
        .select("client_id,first_seen,last_seen,extension_version,browser,os")
        .order("last_seen", desc=True)
        .range(offset, offset + limit - 1)
        .execute()
    )
    rows = installs.data or []
    if not rows:
        return []

    client_ids = [r["client_id"] for r in rows]
    sessions = client.table("sessions").select("client_id").in_("client_id", client_ids).execute()
    session_counts = Counter(s["client_id"] for s in (sessions.data or []))
    events = client.table("events").select("client_id").in_("client_id", client_ids).execute()
    event_counts = Counter(e["client_id"] for e in (events.data or []))

    for r in rows:
        r["total_sessions"] = session_counts.get(r["client_id"], 0)
        r["total_actions"] = event_counts.get(r["client_id"], 0)

    return rows


def get_user_detail(client_id: str, timeline_limit: int = 50) -> Optional[dict]:
    client = get_supabase_client()
    install_res = client.table("installations").select("*").eq("client_id", client_id).limit(1).execute()
    if not install_res.data:
        return None
    install = install_res.data[0]

    sessions_res = client.table("sessions").select("session_id", count="exact").eq("client_id", client_id).execute()
    total_sessions = sessions_res.count or 0

    events_res = (
        client.table("events")
        .select("event_type,feature,action,success,created_at")
        .eq("client_id", client_id)
        .order("created_at", desc=True)
        .limit(500)
        .execute()
    )
    events = events_res.data or []
    type_counts = Counter(e["event_type"] for e in events)

    return {
        "client_id": client_id,
        "first_seen": install.get("first_seen"),
        "last_seen": install.get("last_seen"),
        "total_sessions": total_sessions,
        "total_actions": len(events),
        "screenshots": sum(type_counts[t] for t in _CAPTURE_EVENTS),
        "screen_recordings": sum(type_counts[t] for t in _RECORDING_EVENTS),
        "uploads": sum(type_counts[t] for t in _UPLOAD_EVENTS),
        "links_generated": sum(type_counts[t] for t in _LINK_EVENTS),
        "activity_timeline": events[:timeline_limit],
    }


def get_features_breakdown(days: int = 30) -> list[dict]:
    events = _fetch_events_window(days, select="feature")
    counts = Counter(e["feature"] for e in events if e.get("feature"))
    return [{"feature": f, "count": c} for f, c in counts.most_common(30)]


def get_recent_activity(limit: int = 50) -> list[dict]:
    client = get_supabase_client()
    result = (
        client.table("events")
        .select("client_id,event_type,feature,action,success,created_at")
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return result.data or []


_TIMESERIES_METRICS = {
    "dau": None,  # handled specially: distinct clients per day
    "screenshots": _CAPTURE_EVENTS,
    "recordings": _RECORDING_EVENTS,
    "uploads": _UPLOAD_EVENTS,
    "errors": None,  # handled specially: success == false
}


def get_timeseries(metric: str, days: int = 30) -> list[dict]:
    if metric not in _TIMESERIES_METRICS:
        raise ValueError(f"Unknown metric: {metric}")

    client = get_supabase_client()
    select = "client_id,event_type,success,created_at" if metric in ("dau", "errors") else "event_type,created_at"
    rows = (
        client.table("events")
        .select(select)
        .gte("created_at", _window_start_iso(days))
        .execute()
        .data
        or []
    )

    buckets: dict[str, set] = {}
    counts: dict[str, int] = {}

    for r in rows:
        date_key = str(r["created_at"])[:10]
        if metric == "dau":
            buckets.setdefault(date_key, set()).add(r["client_id"])
        elif metric == "errors":
            if r.get("success") is False:
                counts[date_key] = counts.get(date_key, 0) + 1
        else:
            if r["event_type"] in _TIMESERIES_METRICS[metric]:
                counts[date_key] = counts.get(date_key, 0) + 1

    today = datetime.now(timezone.utc).date()
    series = []
    for i in range(days - 1, -1, -1):
        d = (today - timedelta(days=i)).isoformat()
        if metric == "dau":
            series.append({"date": d, "count": len(buckets.get(d, set()))})
        else:
            series.append({"date": d, "count": counts.get(d, 0)})
    return series
