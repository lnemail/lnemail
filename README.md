# LNemail

Fast anonymous email accounts powered by Bitcoin Lightning Network payments. Get a private disposable email address in seconds - no personal information required, just pay with Bitcoin Lightning and start receiving emails immediately.

## Features

- **Fast & Anonymous**: Get your email address instantly after Bitcoin Lightning payment - no signup, no verification
- **Bitcoin-Powered Privacy**: Pay with Lightning Network for maximum anonymity and speed
- **One-Year Duration**: Email accounts valid for one year with renewal option
- **Receive-Only**: Simple inbox for incoming emails, no attachments or HTML rendering
- **Secure Access**: Token-based authentication with no password storage

## System Architecture

### Components Overview

#### Backend API (FastAPI)
- Core service handling Lightning Network payments, email management, and user authentication
- Connects to LND for Bitcoin Lightning payments via `LNDService`
- Manages email accounts via `EmailService`
- Provides RESTful API endpoints for email reading and account management

#### Database (SQLModel)
- Uses SQLite with SQLModel ORM and Alembic migrations
- Stores email accounts, access tokens, and payment status
- Manages expiration dates for accounts

#### Background Processing (RQ + Redis)
- Manages asynchronous tasks via task queue
- Handles Lightning payment verification via `check_payment_status`
- Processes email account creation after successful Bitcoin payment

#### Mail Server Integration
- Creates individual email accounts via IPC (Inter-Process Communication)
- Uses file-based requests between services with locking mechanism
- Reads emails via IMAP protocol

#### Web Interfaces
- Account creation and Lightning payment interface (`index.html`)
- Email reading interface (`inbox.html`)
- Static assets (CSS, JavaScript) for frontend functionality

## API Endpoints

### Core Endpoints

1. **Create Email Account**
   - `POST /api/v1/email`
   - Generates Bitcoin Lightning invoice
   - Returns invoice details, payment hash, and preliminary account info

2. **Check Payment Status**
   - `GET /api/v1/payment/{payment_hash}`
   - Returns Lightning payment status and account details if paid

3. **List Emails**
   - `GET /api/v1/emails`
   - Requires access token authentication
   - Returns list of email headers

4. **Get Email Content**
   - `GET /api/v1/emails/{email_id}`
   - Requires access token authentication
   - Returns email content with HTML stripped

### Authentication

All email access endpoints require a valid access token passed in the Authorization header:

```
Authorization: Bearer {access_token}
```

## Service Limitations

- **Receiving Only**: You cannot send emails from this service
- **No IMAP Access**: Emails can only be accessed through the web interface or API
- **No Attachments**: Email attachments are not supported or displayed
- **HTML Stripped**: For security, emails are displayed as plain text only

## Technical Implementation

### Email Service
The `EmailService` class handles:
- Account creation via IPC with mail system
- Email listing and fetching via IMAP
- Secure file-based inter-process communication with proper permissions handling
- Email header decoding for internationalization support

### Lightning Payment Processing
The system uses:
- Direct LND integration for Bitcoin Lightning Network payments
- Optional LNProxy integration for enhanced privacy
- Background job processing for Lightning payment verification

### Security Model

1. **Data Protection**
   - Emails stored in individual user mailboxes
   - No long-term data retention (max 1 year)
   - No personal information required from users

2. **Authentication**
   - Token-based authentication with high entropy
   - No password storage for user access

3. **Payment Privacy**
   - Bitcoin Lightning Network payments for maximum privacy
   - No identifying payment information required

## Use Cases

LNemail is ideal for:
- Two-factor authentication requiring fast email delivery
- Account verification where anonymous registration is preferred
- Newsletter subscriptions without personal data exposure
- Services requiring persistent email beyond temporary mail services
- Bitcoin/Lightning-native applications needing email integration

## Development Environment

### Setup

```bash
# Create directories and permissions
mkdir -p dev-data/mail-data
mkdir -p dev-data/mail-state
mkdir -p dev-data/mail-logs
mkdir -p dev-data/config
mkdir -p dev-data/mail-agent
mkdir -p dev-data/shared/requests
mkdir -p dev-data/shared/responses
mkdir -p dev-data/lnemail-data
mkdir -p dev-data/redis-data
mkdir -p docker/lnd

# Set permissions
chmod -R 777 dev-data

# Start all services
docker compose up -d
```

Wait a few minutes for the Bitcoin node to sync and the LND nodes to initialize. You can track the progress with:

```shell
docker logs -f ofelia
docker exec lnd lncli --network=regtest {walletbalance|channelbalance|pendingchannels|listchannels}
```

### Usage

- **Web Interface**: http://localhost:8000
- **API Docs**: http://localhost:8000/docs
- **LND REST**: http://localhost:8081
- **Bitcoin RPC**: Available on port configured in .env

The development environment includes:
- Bitcoin regtest node with automatic mining
- Two LND nodes with channels for Lightning payments
- Mail server for email handling
- Redis for background job processing
- LNemail API and worker services

#### Pay for Email Account

Use the web or API to generate an invoice, then pay it from the second LND node:

```shell
docker exec router_lnd lncli --network=regtest --rpcserver=router_lnd:10010 --tlscertpath=/shared/router_tls.cert --macaroonpath=/shared/router_admin.macaroon payinvoice --force {invoice}
```

### Cleanup

```bash
# Stop and remove everything
docker compose down -v --remove-orphans

# Remove volumes and certificates
docker volume rm lnemail_bitcoin lnemail_lnd lnemail_router_lnd
sudo rm -f dev-data/shared/*.cert dev-data/shared/*.macaroon dev-data/shared/lnd_*
```

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Contact

Contact: [npub1rkh3y6j0a64xyv5f89mpeh8ah68a9jcmjv5mwppc9kr4w9dplg9qpuxk76](https://njump.me/npub1rkh3y6j0a64xyv5f89mpeh8ah68a9jcmjv5mwppc9kr4w9dplg9qpuxk76)
