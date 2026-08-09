from types import SimpleNamespace

from app.object_storage import FileSystemStorage, MinIOStorage, ObjectStorage


def test_file_system_storage_round_trip(tmp_path):
  storage = FileSystemStorage(tmp_path)

  assert storage.put_json("nested/item.json", {"quadrant": 2}) is True
  assert storage.get_json("nested/item.json") == {"quadrant": 2}
  assert storage.list("nested") == ["nested/item.json"]
  assert isinstance(storage, ObjectStorage)


def test_minio_storage_exposes_complete_object_storage_contract():
  class FakeClient:
    def __init__(self):
      self.put_kwargs = None
      self.removed = None

    def put_object(self, **kwargs):
      self.put_kwargs = kwargs

    def remove_object(self, bucket, object_name):
      self.removed = (bucket, object_name)

    def list_objects(self, bucket, prefix, recursive):
      assert (bucket, prefix, recursive) == ("assets", "portfolio/", True)
      return [
        SimpleNamespace(object_name="portfolio/a.png", is_dir=False),
        SimpleNamespace(object_name="portfolio/folder", is_dir=True),
      ]

  client = FakeClient()
  storage = MinIOStorage.__new__(MinIOStorage)
  storage.client = client
  storage.bucket = "assets"

  assert storage.put("/portfolio/a.png", b"image", "image/png") is True
  assert client.put_kwargs["object_name"] == "portfolio/a.png"
  assert client.put_kwargs["content_type"] == "image/png"
  assert storage.list("/portfolio/") == ["portfolio/a.png"]
  assert storage.delete("/portfolio/a.png") is True
  assert client.removed == ("assets", "portfolio/a.png")
