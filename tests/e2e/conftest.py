"""Shared fixtures for end-to-end browser tests.

These tests drive the real web UI against a fully running dev stack
(``docker compose --env-file .env.development up -d``). Lightning
payments are paid by the second LND node (``router_lnd``) over the
already-funded local channel, so each test is "real" e2e but does not
need to wait for chain/channel setup beyond the one-time stack boot.
"""

from __future__ import annotations

import os
import shlex
import subprocess
import time
from pathlib import Path

import pytest


# All tests in this directory are e2e by default.
def pytest_collection_modifyitems(config, items):  # noqa: D401
    for item in items:
        item.add_marker(pytest.mark.e2e)


BASE_URL_ENV = "LNEMAIL_E2E_BASE_URL"
ROUTER_CONTAINER_ENV = "LNEMAIL_E2E_ROUTER_CONTAINER"
API_CONTAINER_ENV = "LNEMAIL_E2E_API_CONTAINER"

# Where videos / screenshots / traces are stored. Gitignored via
# .gitignore: tests/e2e/artifacts/. Override with LNEMAIL_E2E_ARTIFACTS_DIR.
_DEFAULT_ARTIFACTS = Path(__file__).resolve().parent / "artifacts"
ARTIFACTS_DIR = Path(
    os.environ.get("LNEMAIL_E2E_ARTIFACTS_DIR", str(_DEFAULT_ARTIFACTS))
)


@pytest.fixture(scope="session")
def base_url() -> str:
    """Base URL of the running lnemail-api service."""
    return os.environ.get(BASE_URL_ENV, "http://localhost:8000").rstrip("/")


@pytest.fixture(scope="session")
def router_container() -> str:
    """Name of the router LND container used to pay invoices."""
    return os.environ.get(ROUTER_CONTAINER_ENV, "router_lnd")


@pytest.fixture(scope="session")
def api_container() -> str:
    """Name of the lnemail-api container (used for diagnostic shell-outs)."""
    return os.environ.get(API_CONTAINER_ENV, "lnemail-api")


@pytest.fixture(scope="session", autouse=True)
def _stack_ready(base_url: str, router_container: str) -> None:
    """Fail fast with a clear message if the dev stack is not running."""
    import urllib.error
    import urllib.request

    health_url = f"{base_url}/api/health"
    deadline = time.monotonic() + 60
    last_exc: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(health_url, timeout=2) as resp:
                if resp.status == 200:
                    break
        except (urllib.error.URLError, ConnectionError, TimeoutError) as exc:
            last_exc = exc
        time.sleep(1)
    else:
        pytest.skip(
            f"lnemail-api not reachable at {health_url}. "
            "Start the dev stack: "
            "`docker compose --env-file .env.development up -d`. "
            f"Last error: {last_exc!r}"
        )

    # Also verify the router LND container is up so payments will work.
    rc = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", router_container],
        capture_output=True,
        text=True,
    )
    if rc.returncode != 0 or "true" not in rc.stdout:
        pytest.skip(
            f"router LND container '{router_container}' is not running. "
            "Start the dev stack and wait for the LND<->router channel to "
            "open before running e2e tests."
        )


@pytest.fixture(scope="session")
def browser_context_args(browser_context_args, base_url: str):
    """Default browser context: matches the configured base URL, grants
    clipboard permissions, and records a video for every test.

    Videos land in ``tests/e2e/artifacts/videos/<test-name>/...webm``
    (gitignored). On test failure we additionally save a screenshot
    next to the videos via the ``_capture_on_failure`` autouse fixture.
    """
    videos_dir = ARTIFACTS_DIR / "videos"
    videos_dir.mkdir(parents=True, exist_ok=True)
    return {
        **browser_context_args,
        "base_url": base_url,
        "permissions": ["clipboard-read", "clipboard-write"],
        "viewport": {"width": 1280, "height": 800},
        "record_video_dir": str(videos_dir),
        "record_video_size": {"width": 1280, "height": 800},
    }


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_makereport(item, call):
    """Expose test outcome to fixtures via ``item.rep_call`` / ``rep_setup``."""
    outcome = yield
    rep = outcome.get_result()
    setattr(item, f"rep_{rep.when}", rep)


@pytest.fixture(autouse=True)
def _capture_on_failure(request, page):
    """Drop a full-page screenshot next to the video when a test fails."""
    yield
    rep_call = getattr(request.node, "rep_call", None)
    if rep_call is None or not rep_call.failed:
        return
    screenshots_dir = ARTIFACTS_DIR / "screenshots"
    screenshots_dir.mkdir(parents=True, exist_ok=True)
    safe_name = request.node.nodeid.replace("/", "_").replace("::", "__")
    target = screenshots_dir / f"{safe_name}.png"
    try:
        page.screenshot(path=str(target), full_page=True)
    except Exception:  # pragma: no cover - best-effort diagnostic
        pass


@pytest.fixture
def pay_invoice(router_container: str):
    """Return a callable that pays a BOLT11 invoice via the router LND.

    The router node has a pre-funded channel to the merchant LND, so this
    is effectively instant. ``--allow_self_payment`` is harmless even if
    the route is not a self-payment, and is required for self-payments.
    """

    def _pay(bolt11: str, timeout_s: int = 30) -> str:
        if not bolt11 or not bolt11.lower().startswith(("lnbc", "lnbcrt", "lntb", "lnsb")):
            raise ValueError(f"Not a BOLT11 invoice: {bolt11!r}")
        cmd = [
            "docker",
            "exec",
            router_container,
            "lncli",
            "--network=regtest",
            "--rpcserver=router_lnd:10010",
            "--tlscertpath=/shared/router_tls.cert",
            "--macaroonpath=/shared/router_admin.macaroon",
            "payinvoice",
            "--force",
            "--allow_self_payment",
            "--timeout",
            f"{timeout_s}s",
            bolt11,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s + 10)
        if result.returncode != 0:
            raise RuntimeError(
                "payinvoice failed:\n"
                f"  cmd: {shlex.join(cmd)}\n"
                f"  stdout: {result.stdout}\n"
                f"  stderr: {result.stderr}"
            )
        return result.stdout

    return _pay
