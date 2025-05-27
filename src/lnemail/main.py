"""
API entrypoint module.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
import os

from fastapi_cache import FastAPICache
from fastapi_cache.backends.inmemory import InMemoryBackend
from fastapi_cache.decorator import cache

from .api.endpoints import router as api_router, health_router
from .config import settings


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    # Initialize FastAPI Cache with InMemory backend
    # Since templates don't change during runtime, we can cache indefinitely
    FastAPICache.init(InMemoryBackend(), prefix="lnemail-cache")
    yield


app = FastAPI(title=settings.APP_NAME, version=settings.APP_VERSION, lifespan=lifespan)

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


# Frontend routes with caching
@app.get("/", response_class=HTMLResponse)
@cache(expire=21600)
async def index(request: Request) -> HTMLResponse:
    """Home page with payment interface and service information."""
    context = {"request": request, "settings": settings}
    return templates.TemplateResponse("index.html", context)


@app.get("/inbox", response_class=HTMLResponse)
@cache(expire=21600)
async def inbox(request: Request) -> HTMLResponse:
    """Inbox access page for authenticated users."""
    context = {"request": request, "settings": settings}
    return templates.TemplateResponse("inbox.html", context)


@app.get("/tos", response_class=HTMLResponse)
@cache(expire=21600)
async def tos(request: Request) -> HTMLResponse:
    """Terms of Service page."""
    context = {"request": request, "settings": settings}
    return templates.TemplateResponse("tos.html", context)


# Static file serving routes
@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> FileResponse:
    """Serve favicon from static directory."""
    return FileResponse(os.path.join(static_dir, "img/favicon.ico"))


@app.get("/apple-touch-icon.png", include_in_schema=False)
async def apple_touch_icon() -> FileResponse:
    """Serve Apple touch icon."""
    return FileResponse(os.path.join(static_dir, "img/apple-touch-icon.png"))


@app.get("/favicon-16x16.png", include_in_schema=False)
async def favicon_16() -> FileResponse:
    """Serve 16x16 favicon."""
    return FileResponse(os.path.join(static_dir, "img/favicon-16x16.png"))


@app.get("/favicon-32x32.png", include_in_schema=False)
async def favicon_32() -> FileResponse:
    """Serve 32x32 favicon."""
    return FileResponse(os.path.join(static_dir, "img/favicon-32x32.png"))


@app.get("/android-chrome-192x192.png", include_in_schema=False)
async def android_chrome_192() -> FileResponse:
    """Serve Android Chrome 192x192 icon."""
    return FileResponse(os.path.join(static_dir, "img/android-chrome-192x192.png"))


@app.get("/android-chrome-512x512.png", include_in_schema=False)
async def android_chrome_512() -> FileResponse:
    """Serve Android Chrome 512x512 icon."""
    return FileResponse(os.path.join(static_dir, "img/android-chrome-512x512.png"))


@app.get("/site.webmanifest", include_in_schema=False)
async def site_webmanifest() -> FileResponse:
    """Serve site webmanifest file."""
    return FileResponse(os.path.join(static_dir, "site.webmanifest"))


# NIP-05


@app.get(
    "/.well-known/nostr.json", response_class=JSONResponse, include_in_schema=False
)
@cache(expire=86400)  # Cache for 24 hours since this rarely changes
async def nostr_nip05() -> JSONResponse:
    """
    NIP-05 Nostr Identity Verification endpoint.

    This endpoint provides Nostr public key verification for domain-based identity.
    Users can verify their Nostr identity by referencing name@yourdomain.com

    Returns JSON with names mapping to Nostr public keys (hex format).
    """
    nostr_data = {
        "names": {
            "lneamil": "npub1rkh3y6j0a64xyv5f89mpeh8ah68a9jcmjv5mwppc9kr4w9dplg9qpuxk76",
        }
    }

    return JSONResponse(
        content=nostr_data,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET",
            "Access-Control-Allow-Headers": "Content-Type",
            "Content-Type": "application/json",
        },
    )
