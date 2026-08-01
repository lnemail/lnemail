"""Tests for inbox email list sorting.

Verifies that email summaries are sorted chronologically (newest first),
including the mixed-timezone case where lexical isoformat string
comparison would produce the wrong order.
"""

from typing import Any

from lnemail.services.email_service import EmailService


def _summary(email_id: str, parsed_date: Any) -> dict[str, Any]:
    return {"id": email_id, "parsed_date": parsed_date}


def test_sorts_newest_first_same_timezone() -> None:
    emails = [
        _summary("old", "2026-07-01T10:00:00+00:00"),
        _summary("newest", "2026-07-03T10:00:00+00:00"),
        _summary("middle", "2026-07-02T10:00:00+00:00"),
    ]

    EmailService._sort_emails_newest_first(emails)

    assert [e["id"] for e in emails] == ["newest", "middle", "old"]


def test_sorts_chronologically_across_timezones() -> None:
    # Lexical string comparison would order "09:30+00:00" before
    # "10:00+02:00", but 10:00+02:00 is 08:00 UTC, i.e. earlier.
    emails = [
        _summary("earlier", "2026-08-01T10:00:00+02:00"),  # 08:00 UTC
        _summary("later", "2026-08-01T09:30:00+00:00"),  # 09:30 UTC
    ]

    EmailService._sort_emails_newest_first(emails)

    assert [e["id"] for e in emails] == ["later", "earlier"]


def test_unparseable_dates_sort_last() -> None:
    emails = [
        _summary("garbage", "not-a-date"),
        _summary("valid", "2026-08-01T09:30:00+00:00"),
        _summary("missing", None),
    ]

    EmailService._sort_emails_newest_first(emails)

    assert emails[0]["id"] == "valid"
    assert {e["id"] for e in emails[1:]} == {"garbage", "missing"}


def test_naive_datetimes_are_treated_as_utc() -> None:
    emails = [
        _summary("naive_earlier", "2026-08-01T08:00:00"),
        _summary("aware_later", "2026-08-01T09:00:00+00:00"),
    ]

    EmailService._sort_emails_newest_first(emails)

    assert [e["id"] for e in emails] == ["aware_later", "naive_earlier"]
