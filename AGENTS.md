# LNemail

## What it is

Lightning-paid anonymous email accounts.

- pay invoice
- get `email_address` + `access_token`
- use token for web inbox and API
- outgoing mail also needs a Lightning payment

## Stack

- FastAPI
- SQLModel + SQLite + Alembic
- RQ + Redis
- Jinja templates + vanilla JS
- LND for Lightning
- external mailserver via `EmailService`

## Most important files

- `src/lnemail/api/endpoints.py`: main API logic
- `src/lnemail/main.py`: app setup + HTML routes
- `src/lnemail/core/models.py`: DB models
- `src/lnemail/core/schemas.py`: API schemas
- `src/lnemail/core/tokens.py`: token generation/normalization
- `src/lnemail/templates/index.html`: signup/payment flow
- `src/lnemail/templates/inbox.html`: login/inbox UI
- `src/lnemail/static/js/improved/`: frontend logic
- `tests/conftest.py`: app/test fixture setup

## Auth

- bearer token auth
- account lookup happens in `get_current_account()`
- active inbox/send endpoints use `get_current_active_account()`
- expired accounts can still auth during grace period for renewal

Token format:

- `lne_XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`
- Crockford Base32
- human-friendly, no special chars
- new-format tokens are normalized server-side
- legacy non-`lne_` tokens still work

## Common flows

Create account:

- `POST /api/v1/email`
- poll `GET /api/v1/payment/{payment_hash}`

Login:

- `/inbox`
- frontend calls `GET /api/v1/account` with bearer token

Send mail:

- authenticated compose flow creates send invoice
- worker sends after payment confirmation

## Dev commands

Checks:

```bash
prek run --all-files
```

Tests in dev image:

```bash
docker build --target development -t lnemail-test .
docker run --rm -v "$(pwd)":/app -w /app lnemail-test bash -c "pip install --quiet httpx && pytest"
```

Full stack:

```bash
docker compose --env-file .env.development up -d
```

App URLs:

- `http://localhost:8000`
- `http://localhost:8000/docs`

## Gotchas

- `endpoints.py` is large and central
- service constructors are patched before app import in tests
- browser/password-manager behavior lives in templates + `static/js/improved/`
- for token/auth changes, update tests
