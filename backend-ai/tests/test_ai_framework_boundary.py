from pathlib import Path


ROOT = Path(__file__).parents[1]


def test_production_dependencies_do_not_install_experimental_frameworks():
  requirements = ROOT.joinpath("requirements.txt").read_text(encoding="utf-8")

  assert "requirements-experimental.txt" not in requirements
  assert "haystack" not in requirements.lower()
  assert "langchain" not in requirements.lower()
  assert "llama-index" not in requirements.lower()


def test_application_contracts_do_not_import_ai_framework_types():
  forbidden = ("haystack", "langchain", "llama_index", "langgraph")
  boundary_files = [
    ROOT / "app" / "rag" / "models.py",
    ROOT / "app" / "rag" / "ports.py",
    ROOT / "app" / "rag" / "application.py",
  ]

  for path in boundary_files:
    source = path.read_text(encoding="utf-8").lower()
    assert all(name not in source for name in forbidden), path
