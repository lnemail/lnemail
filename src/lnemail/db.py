"""
Database configuration and session management.

This module provides database connection setup, engine creation,
and session dependency for the FastAPI application.
"""

from contextlib import contextmanager
from typing import Generator

from sqlmodel import Session, SQLModel, create_engine

from .config import settings

# Create database engine with connection pooling
engine = create_engine(
    settings.DATABASE_URL,
    echo=settings.DEBUG,
    connect_args=(
        {"check_same_thread": False}
        if settings.DATABASE_URL.startswith("sqlite")
        else {}
    ),
    pool_pre_ping=True,
    pool_recycle=300,
)


def init_db() -> None:
    """Initialize database with all defined SQLModel tables."""
    # Import models here to ensure they're registered with SQLModel
    from .core.models import EmailAccount  # noqa

    SQLModel.metadata.create_all(engine)


@contextmanager
def get_db_session() -> Generator[Session, None, None]:
    """Provide a transactional database session scope.

    Yields:
        SQLModel Session: Database session
    """
    session = Session(engine)
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency for database sessions.

    Yields:
        SQLModel Session: Database session for request
    """
    with get_db_session() as session:
        yield session
