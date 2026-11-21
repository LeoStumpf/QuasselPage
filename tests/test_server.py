from fastapi.testclient import TestClient

from quasselpage.library import Library
from quasselpage.server import create_app


def client(tmp_path):
    return TestClient(create_app(Library(tmp_path), start_renderer=False))


def test_import_text_and_position(tmp_path):
    c = client(tmp_path)
    r = c.post("/api/import/text", json={"text": "Hello there. General Kenobi.", "title": "T"})
    assert r.status_code == 200
    doc_id = r.json()["id"]
    assert [d["id"] for d in c.get("/api/docs").json()] == [doc_id]
    assert c.post(f"/api/docs/{doc_id}/position", json={"sid": 1, "playing": False}).json()["ok"]
    assert c.get(f"/api/docs/{doc_id}").json()["meta"]["position"] == 1
    assert c.get(f"/api/docs/{doc_id}/page.html").status_code == 200
    assert c.delete(f"/api/docs/{doc_id}").json()["ok"]
    assert c.get("/api/docs").json() == []


def test_rejects_foreign_origin_and_host(tmp_path):
    c = client(tmp_path)
    r = c.post("/api/import/text", json={"text": "x."}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert c.get("/api/docs", headers={"Host": "evil.example"}).status_code == 403


def test_unknown_doc_and_bad_id(tmp_path):
    c = client(tmp_path)
    assert c.get("/api/docs/abc123").status_code == 404
    assert c.get("/api/docs/..%2F..").status_code == 404
