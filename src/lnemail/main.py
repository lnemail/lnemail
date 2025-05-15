"""
API entrypoint module.
"""

from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, FileResponse
import os

from .api.endpoints import router as api_router, health_router
from .config import settings

app = FastAPI(title=settings.APP_NAME, version=settings.APP_VERSION)

# Get the directory of the current file (main.py)
current_dir = Path(__file__).parent

# Mount static files using the correct path
static_dir = current_dir / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

# Set up templates with the correct path
templates_dir = current_dir / "templates"
templates = Jinja2Templates(directory=str(templates_dir))

# Include API routers
app.include_router(api_router, prefix="/api/v1")
app.include_router(health_router, prefix="/api")


# Frontend routes
@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "index.html", {"request": request, "settings": settings}
    )


@app.get("/inbox", response_class=HTMLResponse)
async def inbox(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "inbox.html", {"request": request, "settings": settings}
    )


# Serve favicon.ico from the root path
@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> FileResponse:
    return FileResponse(os.path.join(static_dir, "img/favicon.ico"))


@app.get("/apple-touch-icon.png", include_in_schema=False)
async def apple_touch_icon() -> FileResponse:
    return FileResponse(os.path.join(static_dir, "img/apple-touch-icon.png"))


@app.get("/favicon-16x16.png", include_in_schema=False)
async def favicon_16() -> FileResponse:
    return FileResponse(os.path.join(static_dir, "img/favicon-16x16.png"))


@app.get("/favicon-32x32.png", include_in_schema=False)
async def favicon_32() -> FileResponse:
    return FileResponse(os.path.join(static_dir, "img/favicon-32x32.png"))


@app.get("/android-chrome-192x192.png", include_in_schema=False)
async def android_chrome_192() -> FileResponse:
    return FileResponse(os.path.join(static_dir, "img/android-chrome-192x192.png"))


@app.get("/android-chrome-512x512.png", include_in_schema=False)
async def android_chrome_512() -> FileResponse:
    return FileResponse(os.path.join(static_dir, "img/android-chrome-512x512.png"))


@app.get("/site.webmanifest", include_in_schema=False)
async def site_webmanifest() -> FileResponse:
    return FileResponse(os.path.join(static_dir, "site.webmanifest"))
