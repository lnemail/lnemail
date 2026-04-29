# End-to-end tests

Realistic browser tests that drive the lnemail web UI against the
local docker-compose dev stack. They pay every Lightning invoice for
real over the pre-funded regtest channel between the two LND nodes,
so the full create-account / send-email flow is exercised the same
way a real user would.

## What is covered

- `test_signup_and_login.py` - full signup with real LN payment,
  auto-login on the same browser, manual token login from a fresh
  isolated browser context.
- `test_inbox_send_and_read.py` - login, compose an email to the
  account itself, pay the send invoice, wait for delivery, open the
  message, reply to it, pay again, verify the reply lands.

The suite is intentionally small: the priority is detecting regressions
in the core paying / sending / receiving / reading / replying loop, not
covering every UI permutation.

## Prerequisites

1. The dev stack is running and healthy:

    ```bash
    bash scripts/setup.sh
    docker compose --env-file .env.development up -d
    # wait for the merchant<->router channel to open
    docker exec lnd lncli --network=regtest listchannels | jq '.channels|length'
    ```

2. Python deps including the e2e group are installed and the Playwright
   browsers are downloaded:

    ```bash
    poetry install --with e2e
    poetry run playwright install --with-deps chromium
    ```

   With pip:

    ```bash
    pip install pytest-playwright
    playwright install --with-deps chromium
    ```

## Running

```bash
# Headless (CI mode)
./tests/e2e/run.sh

# Headed + slow-motion, useful when debugging locally
./tests/e2e/run.sh --watch

# Forward extra args to pytest
./tests/e2e/run.sh -- -k signup
```

Or invoke pytest directly:

```bash
poetry run pytest tests/e2e -v
```

### Artifacts (videos, screenshots, traces)

Every test records a video under `tests/e2e/artifacts/videos/`. On
failure, a full-page screenshot is saved under
`tests/e2e/artifacts/screenshots/`, and (when run via `run.sh`) a
Playwright trace is saved under `tests/e2e/artifacts/playwright/` -
load it with `playwright show-trace <path>` for a step-by-step replay.
The whole `artifacts/` directory is gitignored.

Useful overrides (env vars):

- `LNEMAIL_E2E_BASE_URL` - default `http://localhost:8000`.
- `LNEMAIL_E2E_ROUTER_CONTAINER` - default `router_lnd`.
- `LNEMAIL_E2E_API_CONTAINER` - default `lnemail-api`.
- `LNEMAIL_E2E_ARTIFACTS_DIR` - default `tests/e2e/artifacts/`.

Headed mode (debug) without `run.sh`:

```bash
poetry run pytest tests/e2e -v --headed --slowmo=300
```

## Why these tests are excluded from the default `pytest` run

`pyproject.toml` lists `tests/e2e` under `norecursedirs` for the default
session. The standard unit/integration suite must remain runnable
without docker. Run e2e explicitly via the path, as shown above.
