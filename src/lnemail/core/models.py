"""
Core data models for the LNemail application.
This module contains SQLModel table definitions that map to database tables
and provide data validation, relationships, and utility methods.
"""

import secrets
import string
from datetime import datetime, timedelta
from enum import Enum
from typing import ClassVar
from sqlmodel import Field, SQLModel


class PaymentStatus(str, Enum):
    """Enum for payment status values."""

    PENDING = "pending"
    PAID = "paid"
    EXPIRED = "expired"
    FAILED = "failed"


class EmailAccount(SQLModel, table=True):
    """Email account model representing user accounts in the system."""

    __tablename__: ClassVar[str] = "email_accounts"
    id: int | None = Field(default=None, primary_key=True)
    email_address: str = Field(unique=True, index=True)
    access_token: str = Field(unique=True, index=True)
    email_password: str = Field(default="")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    expires_at: datetime = Field(
        default_factory=lambda: datetime.utcnow() + timedelta(days=365)
    )
    original_payment_request: str | None = Field(default=None)
    payment_hash: str = Field(index=True)
    payment_status: PaymentStatus = Field(default=PaymentStatus.PENDING)

    @classmethod
    def generate_random_email(cls, domain: str = "lnemail.net") -> str:
        """Generate a random email address with a recognizable pattern.
        Args:
            domain: The domain name for the email address
        Returns:
            A randomly generated email address string
        """
        ADJECTIVES = [
            "swift",
            "nimble",
            "quiet",
            "brave",
            "wise",
            "calm",
            "keen",
            "bold",
            "agile",
            "sharp",
            "mighty",
            "gentle",
            "clever",
            "witty",
            "cosmic",
            "mystic",
            "daring",
            "vibrant",
            "radiant",
            "serene",
            "royal",
            "silent",
            "golden",
            "silver",
            "crystal",
            "hidden",
            "ancient",
            "stellar",
            "dreamy",
            "lively",
            "eager",
            "wild",
            "fierce",
            "noble",
            "rapid",
            "vivid",
            "subtle",
            "lucid",
            "flowing",
            "steady",
            "proud",
            "humble",
            "bright",
            "dark",
            "swift",
            "sleek",
            "smooth",
            "rugged",
            "electric",
            "magnetic",
        ]
        NOUNS = [
            "raven",
            "falcon",
            "wolf",
            "river",
            "peak",
            "path",
            "spark",
            "wave",
            "cloud",
            "forest",
            "phoenix",
            "dragon",
            "tiger",
            "eagle",
            "lion",
            "bear",
            "shark",
            "hawk",
            "panther",
            "fox",
            "pixel",
            "byte",
            "data",
            "node",
            "circuit",
            "cipher",
            "pulse",
            "nexus",
            "orbit",
            "prism",
            "puma",
            "lynx",
            "reef",
            "delta",
            "echo",
            "summit",
            "cove",
            "dune",
            "mesa",
            "fjord",
            "gem",
            "crystal",
            "dawn",
            "dusk",
            "shadow",
            "flame",
            "frost",
            "storm",
            "star",
            "comet",
        ]
        VERBS = [
            "run",
            "jump",
            "fly",
            "swim",
            "dance",
            "sing",
            "code",
            "build",
            "create",
            "design",
            "spark",
            "glow",
            "shine",
            "blast",
            "zoom",
            "drift",
            "glide",
            "forge",
            "craft",
            "blend",
            "hack",
            "dash",
            "pulse",
            "surge",
            "boost",
            "weave",
            "orbit",
            "morph",
            "shift",
            "flow",
            "beam",
            "flash",
            "soar",
            "dive",
            "climb",
            "prowl",
            "hunt",
            "seek",
            "find",
            "explore",
        ]
        COLORS = [
            "red",
            "blue",
            "green",
            "black",
            "white",
            "gold",
            "silver",
            "azure",
            "amber",
            "crimson",
            "indigo",
            "violet",
            "teal",
            "coral",
            "jade",
            "ruby",
            "onyx",
            "sapphire",
            "emerald",
            "topaz",
            "bronze",
            "copper",
            "platinum",
            "obsidian",
            "turquoise",
            "amethyst",
            "cobalt",
            "scarlet",
            "ebony",
            "ivory",
        ]
        TECH = [
            "cyber",
            "crypto",
            "pixel",
            "byte",
            "data",
            "node",
            "web",
            "net",
            "cloud",
            "tech",
            "digital",
            "binary",
            "quantum",
            "nano",
            "meta",
            "vector",
            "neural",
            "matrix",
            "proxy",
            "signal",
            "laser",
            "plasma",
            "fusion",
            "solar",
            "lunar",
            "cosmic",
            "stellar",
            "astro",
            "hyper",
            "mega",
            "echo",
            "pulse",
            "wave",
            "spectrum",
            "quantum",
            "atomic",
            "ionic",
            "molecular",
            "circuit",
            "chip",
        ]
        numbers = "".join(secrets.choice(string.digits) for _ in range(3))
        # only logical combination (adjective+noun, verb+noun, color+noun, tech+noun) and random number
        name_type = secrets.choice(["adj_noun", "verb_noun", "color_noun", "tech_noun"])
        if name_type == "adj_noun":
            nickname = f"{secrets.choice(ADJECTIVES)}{secrets.choice(NOUNS)}{numbers}"
        elif name_type == "verb_noun":
            nickname = f"{secrets.choice(VERBS)}{secrets.choice(NOUNS)}{numbers}"
        elif name_type == "color_noun":
            nickname = f"{secrets.choice(COLORS)}{secrets.choice(NOUNS)}{numbers}"
        else:
            nickname = f"{secrets.choice(TECH)}{secrets.choice(NOUNS)}{numbers}"
        return f"{nickname}@{domain}"

    @classmethod
    def generate_access_token(cls) -> str:
        """Generate a cryptographically secure access token.
        Returns:
            A URL-safe token string
        """
        return secrets.token_urlsafe(32)


class Email(SQLModel, table=True):
    """Model for tracking emails received by accounts (optional extension)."""

    __tablename__: ClassVar[str] = "emails"
    id: int | None = Field(default=None, primary_key=True)
    account_id: int = Field(foreign_key="email_accounts.id", index=True)
    message_id: str = Field(index=True)
    sender: str = Field()
    subject: str = Field(default="")
    received_at: datetime = Field(default_factory=datetime.utcnow)
    read: bool = Field(default=False)


class PendingOutgoingEmail(SQLModel, table=True):
    """Model for tracking pending outgoing emails requiring payment."""

    __tablename__: ClassVar[str] = "pending_outgoing_emails"
    id: int | None = Field(default=None, primary_key=True)
    sender_email: str = Field(index=True)
    recipient: str
    subject: str
    body: str
    payment_hash: str = Field(unique=True, index=True)
    payment_request: str
    price_sats: int
    status: PaymentStatus = Field(default=PaymentStatus.PENDING)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    # TTL for pending emails, e.g., 1 hour to prevent stale invoices
    expires_at: datetime = Field(
        default_factory=lambda: datetime.utcnow() + timedelta(hours=1)
    )
