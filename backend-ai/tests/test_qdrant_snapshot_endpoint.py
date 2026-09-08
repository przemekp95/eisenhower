from hashlib import sha256
from types import SimpleNamespace

from scripts import verify_qdrant_recovery


class FakeClient:
  def __init__(self):
    point = SimpleNamespace(id="point-1", payload={"text": "approved"}, vector=[1.0])
    self.collections = {"candidate": [point]}

  def scroll(self, *, collection_name, **_kwargs):
    return self.collections[collection_name], None

  def collection_exists(self, collection_name):
    return collection_name in self.collections

  def delete_collection(self, *, collection_name):
    del self.collections[collection_name]

  @staticmethod
  def list_snapshots(_collection_name):
    return [SimpleNamespace(name="candidate.snapshot")]


class FakeManager:
  snapshot = b"snapshot-bytes"

  @classmethod
  def create_snapshot(cls, _collection_name):
    return SimpleNamespace(
      name="candidate.snapshot",
      checksum=sha256(cls.snapshot).hexdigest(),
    )

  def __init__(self, client):
    self.client = client

  def restore_uploaded_snapshot(self, collection_name, _content, *, checksum):
    assert checksum == sha256(self.snapshot).hexdigest()
    self.client.collections[collection_name] = self.client.collections["candidate"]

  @staticmethod
  def delete_snapshot(_artifact):
    return None


def test_candidate_snapshot_download_uses_explicit_qdrant_endpoint(tmp_path, monkeypatch):
  requested = []

  def fake_get(url, *, timeout):
    requested.append((url, timeout))
    return SimpleNamespace(
      content=FakeManager.snapshot,
      raise_for_status=lambda: None,
    )

  monkeypatch.setattr(verify_qdrant_recovery.httpx, "get", fake_get)
  client = FakeClient()
  report = verify_qdrant_recovery.verify_candidate_collection_snapshot(
    client,
    FakeManager(client),
    "candidate",
    tmp_path / "candidate.snapshot",
    qdrant_url="http://127.0.0.1:6343",
  )

  assert requested == [(
    "http://127.0.0.1:6343/collections/candidate/snapshots/candidate.snapshot",
    30,
  )]
  assert report["matches_source"] is True
