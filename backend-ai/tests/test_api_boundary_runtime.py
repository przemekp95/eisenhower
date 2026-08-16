from pathlib import Path

from app.api_boundary import _private_upstream


ROOT = Path(__file__).parents[1]


def test_boundary_requirements_exclude_heavy_ai_and_storage_dependencies():
  requirements = ROOT.joinpath("requirements-boundary.txt").read_text(encoding="utf-8").lower()
  forbidden = (
    "torch",
    "torchvision",
    "sentence-transformers",
    "transformers",
    "docling",
    "unstructured",
    "onnx",
    "tesseract",
    "pillow",
    "pymongo",
    "qdrant",
    "llama-index",
  )

  assert all(package not in requirements for package in forbidden)


def test_dockerfile_has_dedicated_boundary_and_knowledge_role_targets():
  dockerfile = ROOT.joinpath("Dockerfile").read_text(encoding="utf-8")

  assert "FROM requirements-source AS dependencies-boundary" in dockerfile
  assert "FROM runtime-base AS boundary" in dockerfile
  assert "COPY --from=dependencies-boundary /opt/python /opt/python" in dockerfile
  assert "FROM runtime-base AS knowledge" in dockerfile
  assert "COPY --from=dependencies-knowledge /opt/python /opt/python" in dockerfile
  assert 'app.api_boundary:from_environment' in dockerfile
  assert "requirements-knowledge.txt" in dockerfile


def test_boundary_rejects_public_or_unallowlisted_upstream_urls():
  assert not _private_upstream("https://example.com", ("knowledge-service",))
  assert not _private_upstream("http://knowledge-service:8000", ("other-service",))
  assert _private_upstream("http://knowledge-service:8000", ("knowledge-service",))
