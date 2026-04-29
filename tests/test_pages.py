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
