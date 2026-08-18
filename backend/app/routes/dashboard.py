"""
app/routes/dashboard.py
Serves the analytics admin dashboard (GET /dashboard). The page itself is
static HTML/JS -- all data comes from the /api/analytics/* endpoints via
client-side fetch calls, using the same optional token gate.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

router = APIRouter()

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


@router.get("/dashboard", response_class=HTMLResponse)
def dashboard_page(request: Request):
    return templates.TemplateResponse(request, "dashboard.html", {})
