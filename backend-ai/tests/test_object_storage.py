from io import BytesIO

import pytest

from app.object_storage import FileSystemStorage, MinIOStorage


def test_filesystem_storage_round_trip_and_json(tmp_path):
  storage = FileSystemStorage(tmp_path)

  assert storage.put("nested/value.bin", BytesIO(b"payload")) is True
  assert storage.get("nested/value.bin") == b"payload"
  assert storage.put_json("nested/value.json", {"ok": True}) is True
  assert storage.get_json("nested/value.json") == {"ok": True}
  assert storage.list("nested") == ["nested/value.bin", "nested/value.json"]


def test_filesystem_storage_rejects_path_traversal(tmp_path):
  storage = FileSystemStorage(tmp_path)

  with pytest.raises(ValueError):
    storage.get("../outside.txt")
class FakeObject:
    def __init__(self, name: str, *, is_dir: bool = False):
        self.object_name = name
        self.is_dir = is_dir


class FakeMinioClient:
    def __init__(self):
        self.put_calls = []
        self.removed = []

    def put_object(self, **kwargs):
        self.put_calls.append(kwargs)

    def remove_object(self, bucket, path):
        self.removed.append((bucket, path))

    def list_objects(self, bucket, prefix, recursive):
        assert (bucket, prefix, recursive) == ("tasks", "models/", True)
        return [FakeObject("models/b.pt"), FakeObject("models/a.pt"), FakeObject("models/subdir", is_dir=True)]


def test_filesystem_storage_round_trips_json_and_blocks_path_traversal(tmp_path):
    storage = FileSystemStorage(tmp_path / "objects")

    assert storage.put_json("models/meta.json", {"generation": "g1"}) is True
    assert storage.exists("models/meta.json") is True
    assert storage.get_json("models/meta.json") == {"generation": "g1"}
    assert storage.list("models") == ["models/meta.json"]
    assert storage.delete("models/meta.json") is True
    assert storage.get("models/meta.json") is None
    with pytest.raises(ValueError, match="Nieprawidłowa ścieżka"):
        storage.get("../outside.json")


def test_minio_storage_put_list_and_delete_use_normalized_object_paths():
    client = FakeMinioClient()
    storage = MinIOStorage.__new__(MinIOStorage)
    storage.client = client
    storage.bucket = "tasks"

    assert storage.put("/models/head.pt", BytesIO(b"model"), "application/octet-stream") is True
    assert client.put_calls[0]["object_name"] == "models/head.pt"
    assert client.put_calls[0]["length"] == 5
    assert storage.list("/models/") == ["models/a.pt", "models/b.pt"]
    assert storage.delete("/models/head.pt") is True
    assert client.removed == [("tasks", "models/head.pt")]
