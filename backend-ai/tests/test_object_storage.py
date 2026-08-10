from io import BytesIO

import pytest

from app.object_storage import FileSystemStorage


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
