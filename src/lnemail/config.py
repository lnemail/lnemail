"""
Configuration settings for the LNemail application.
This module provides a centralized configuration management system using Pydantic Settings.
All environment variables are loaded and validated here before being used in the application.
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Application settings
    APP_NAME: str = "LNemail"
    APP_VERSION: str = "0.3.0"
    DEBUG: bool = False

    # Server settings
    HOST: str = "0.0.0.0"
    PORT: int = 8000

    # Database
    DATABASE_URL: str = "sqlite:///./data/lnemail.db"

    # Email settings
    MAIL_DOMAIN: str = "lnemail.net"
    MAIL_DATA_PATH: str = "/data/lnemail/mail-data"
    MAIL_REQUESTS_DIR: str = "/shared/requests"
    MAIL_RESPONSES_DIR: str = "/shared/responses"
    IMAP_HOST: str = "mail.lnemail.net"
    IMAP_PORT: int = 143

    # SMTP settings for sending emails
    SMTP_HOST: str = "mail.lnemail.net"
    SMTP_PORT: int = 587
    SMTP_USE_TLS: bool = True

    # LND settings
    LND_GRPC_HOST: str = "lnd:10009"
    LND_CERT_PATH: str = "/lnd/tls.cert"
    LND_MACAROON_PATH: str = "/lnd/data/chain/bitcoin/mainnet/admin.macaroon"

    # Payment settings
    EMAIL_PRICE: int = 1000
    EMAIL_SEND_PRICE: int = 100  # New: Price for sending one email
    RENEWAL_PRICE: int = 1000  # Price per year for account renewal

    # LNProxy settings
    USE_LNPROXY: bool = True
    LNPROXY_URL: str = "https://lnproxy.org/spec"

    # Redis settings
    REDIS_HOST: str = "redis"
    REDIS_PORT: int = 6379

    # Security
    SECRET_KEY: str = "CHANGE_THIS_TO_A_RANDOM_VALUE_IN_PRODUCTION"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 365 * 10  # 10 year

    class Config:
        """Pydantic config settings."""

        env_file = ".env"
        case_sensitive = True
        extra = "ignore"


# Create global settings instance
settings = Settings()
