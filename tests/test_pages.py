"""Smoke tests for server-rendered HTML routes."""

from fastapi.testclient import TestClient


def test_index_page_renders(client: TestClient) -> None:
    response = client.get("/")

    assert response.status_code == 200, response.text
    assert "LNemail" in response.text


def test_inbox_page_renders(client: TestClient) -> None:
    response = client.get("/inbox")

    assert response.status_code == 200, response.text
    assert "LNemail Access" in response.text


def test_tos_page_renders(client: TestClient) -> None:
    response = client.get("/tos")

    assert response.status_code == 200, response.text
    assert "Terms" in response.text


def test_skill_md_canonical(client: TestClient) -> None:
    response = client.get("/SKILL.md")

    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/plain")
    assert "LNemail" in response.text


def test_skill_md_lowercase_redirects(client: TestClient) -> None:
    response = client.get("/skill.md", follow_redirects=False)

    assert response.status_code == 301
    assert response.headers["location"] == "/SKILL.md"
