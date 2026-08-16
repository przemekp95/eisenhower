from pathlib import Path


ROOT = Path(__file__).parents[1]


def test_only_knowledge_dependencies_install_the_selected_rag_framework():
  requirements = ROOT.joinpath("requirements.txt").read_text(encoding="utf-8").lower()
  knowledge_requirements = ROOT.joinpath("requirements-knowledge.txt").read_text(encoding="utf-8").lower()

  assert "requirements-experimental.txt" not in requirements
  assert "haystack" not in requirements.lower()
  assert "langchain" not in requirements.lower()
  assert "llama-index" not in requirements.lower()
  assert "llama-index-core==0.14.23" in knowledge_requirements
  assert "llama-index-vector-stores-qdrant==0.10.3" in knowledge_requirements
  assert "qdrant-client==1.19.0" in knowledge_requirements
  assert "llama-index" not in ROOT.joinpath("requirements-boundary.txt").read_text(encoding="utf-8").lower()


def test_standard_dev_dependencies_do_not_install_experimental_frameworks():
  requirements = ROOT.joinpath("requirements-dev.txt").read_text(encoding="utf-8").lower()

  assert "requirements-experimental.txt" not in requirements
  assert "langchain" not in requirements
  assert "haystack" not in requirements


def test_application_contracts_do_not_import_ai_framework_types():
  forbidden = ("haystack", "langchain", "llama_index", "langgraph")
  boundary_files = [
    ROOT / "app" / "rag" / "models.py",
    ROOT / "app" / "rag" / "ports.py",
    ROOT / "app" / "rag" / "application.py",
    ROOT / "app" / "api_boundary.py",
  ]

  for path in boundary_files:
    source = path.read_text(encoding="utf-8").lower()
    assert all(name not in source for name in forbidden), path


def test_core_vector_package_does_not_eagerly_import_optional_langchain_adapter():
  package_init = ROOT.joinpath("app/vector/__init__.py").read_text(encoding="utf-8").lower()

  assert "langchain_adapter" not in package_init
  assert "eisenhowerembeddings" not in package_init
  assert "langchainqdrantadapter" not in package_init


def test_dockerfile_has_one_unambiguous_cpu_production_stage():
  dockerfile = ROOT.joinpath("Dockerfile").read_text(encoding="utf-8").lower()

  assert dockerfile.count(" as production\n") == 1
