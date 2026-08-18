"""
app/main.py
FastAPI application entrypoint for the SatyLens backend.

Run locally:
    uvicorn app.main:app --reload --port 8000
"""
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.routes import analytics, dashboard, health, media, share, upload

settings = get_settings()

app = FastAPI(
    title="SatyLens API",
    description="Backend for the SatyLens Chrome extension — upload and share captures.",
    version="1.6.0",
)

# CORS: only the Chrome extension origin(s) (and any explicitly allowed extra
# origins) may call this API. Never use allow_origins=["*"] in production —
# that would let any website on the internet call your upload endpoint.
cors_origins = settings.cors_origins or ["http://localhost:8000"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# Serves app/static/logo.png for the share viewer and analytics dashboard
# (both public-facing HTML pages meant to be opened directly in a browser,
# unlike the JSON API routes, which don't need this).
STATIC_DIR = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

app.include_router(health.router)
app.include_router(upload.router)
app.include_router(share.router)
app.include_router(analytics.router)
app.include_router(dashboard.router)
app.include_router(media.router)


@app.get("/")
def root():
    return {
        "service": "SatyLens API",
        "status": "ok",
        "docs": "/docs",
    }

