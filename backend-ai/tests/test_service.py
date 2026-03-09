from __future__ import annotations

from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

from PIL import Image

from app.classifier import HeuristicClassifier
from app.config import Settings
from app.service import (
  AdvancedQuadrantAnalysis,
  ExtractedTasksPayload,
  QuadrantAIService,
  QuadrantClassification,
  SimilarExample,
  cosine_similarity,
  localize_reasoning_quadrant_reference,
  lexical_similarity,
  normalize_extracted_tasks,
  quadrant_to_flags,
)
from app.store import TrainingStore


class FakeResponses:
  def __init__(self, outputs: list[object]):
    self.outputs = list(outputs)
    self.calls: list[dict] = []

  def parse(self, **kwargs):
    self.calls.append(kwargs)
    output = self.outputs.pop(0)
    if isinstance(output, Exception):
      raise output
    return SimpleNamespace(output_parsed=output)


class FakeEmbeddings:
  def __init__(self, batches: list[list[list[float]]]):
    self.batches = list(batches)
    self.calls: list[dict] = []

  def create(self, **kwargs):
    self.calls.append(kwargs)
    batch = self.batches.pop(0)
    return SimpleNamespace(data=[SimpleNamespace(embedding=embedding) for embedding in batch])


class FakeOpenAIClient:
  def __init__(
    self,
    response_outputs: list[object] | None = None,
    embedding_batches: list[list[list[float]]] | None = None,
  ):
    self.responses = FakeResponses(response_outputs or [])
    self.embeddings = FakeEmbeddings(embedding_batches or [])


def build_service(
  tmp_path: Path,
  *,
  openai_client=None,
  openai_api_key: str | None = None,
  ocr_runner=None,
) -> QuadrantAIService:
  settings = Settings(
    training_data_path=tmp_path / "training.json",
    model_cache_dir=tmp_path / "runtime",
    openai_api_key=openai_api_key,
  )
  store = TrainingStore(settings.training_data_path)
  return QuadrantAIService(
    settings=settings,
    store=store,
    fallback_classifier=HeuristicClassifier(),
    openai_client=openai_client,
    ocr_runner=ocr_runner,
  )


def png_payload() -> bytes:
  image = Image.new("RGB", (4, 4), "white")
  buffer = BytesIO()
  image.save(buffer, format="PNG")
  return buffer.getvalue()


def test_service_helpers_cover_normalization_similarity_and_flags():
  assert quadrant_to_flags(0) == (True, True)
  assert quadrant_to_flags(1) == (True, False)
  assert quadrant_to_flags(2) == (False, True)
  assert quadrant_to_flags(3) == (False, False)

  normalized = normalize_extracted_tasks(
    [" urgent   outage ", "", "-urgent outage-", "Plan roadmap", "plan roadmap"]
  )
  assert normalized == ["urgent outage", "Plan roadmap"]

  assert cosine_similarity([0.0, 0.0], [1.0, 0.0]) == 0.0
  assert round(cosine_similarity([1.0, 1.0], [1.0, 1.0]), 4) == 1.0

  assert lexical_similarity("", "task") == 0.0
  assert lexical_similarity("pilne zadanie", "pilne nowe zadanie") > 0
  assert (
    localize_reasoning_quadrant_reference(
      "Klasyfikacja do kwadrantu 1 jest uzasadniona.",
      1,
      "pl",
    )
    == "Klasyfikacja do kwadrantu „Zaplanuj” jest uzasadniona."
  )
  assert (
    localize_reasoning_quadrant_reference("Quadrant 2 is the best fit.", 2, "en")
    == '"Delegate" quadrant is the best fit.'
  )
  assert (
    localize_reasoning_quadrant_reference(
      "Najlepszy jest kwadrant 1 (Zaplanuj).",
      1,
      "pl",
    )
    == "Najlepszy jest kwadrant „Zaplanuj”."
  )
  assert localize_reasoning_quadrant_reference("Leave this as-is.", None, "pl") == "Leave this as-is."

  example = SimilarExample(text="Prepare roadmap", quadrant=2, source="user", score=0.98765)
  assert example.to_dict() == {
    "text": "Prepare roadmap",
    "quadrant": 2,
    "quadrant_name": "Delegate",
    "source": "user",
    "score": 0.9877,
  }


def test_service_initialization_capabilities_and_private_helpers(tmp_path: Path, monkeypatch):
  service_without_ai = build_service(tmp_path)
  assert service_without_ai.openai_client is None

  monkeypatch.setattr(service_without_ai, "_tesseract_available", lambda: False)
  capabilities = service_without_ai.capabilities()
  assert capabilities["providers"]["openai"] is False
  assert capabilities["providers"]["tesseract"] is False

  explicit_client = object()
  explicit_service = build_service(tmp_path, openai_client=explicit_client)
  assert explicit_service.openai_client is explicit_client

  captured: dict[str, object] = {}

  class FakeOpenAI:
    def __init__(self, **kwargs):
      captured.update(kwargs)

  monkeypatch.setattr("app.service.OpenAI", FakeOpenAI)
  constructor_service = build_service(tmp_path, openai_api_key="secret-key")
  assert isinstance(constructor_service.openai_client, FakeOpenAI)
  assert captured["api_key"] == "secret-key"
  assert captured["timeout"] == 30.0

  monkeypatch.setattr(constructor_service, "_tesseract_available", lambda: True)
  provider_capabilities = constructor_service.capabilities()
  assert provider_capabilities["providers"]["vision"] is True
  assert provider_capabilities["providers"]["ocr"] is True

  with_examples = constructor_service._build_text_input(
    "Prepare roadmap",
    [SimilarExample(text="Plan roadmap", quadrant=2, source="feedback", score=0.8)],
  )
  with_polish_examples = constructor_service._build_text_input(
    "Przygotuj roadmapę",
    [SimilarExample(text="Plan roadmap", quadrant=2, source="feedback", score=0.8)],
    "pl",
  )
  without_examples = constructor_service._build_text_input("Prepare roadmap", [])
  assert "Plan roadmap -> Delegate" in with_examples[0]["content"][0]["text"]
  assert "Plan roadmap -> Deleguj" in with_polish_examples[0]["content"][0]["text"]
  assert "No directly similar prior examples." in without_examples[0]["content"][0]["text"]

  assert constructor_service._looks_like_image("board.png", None) is True
  assert constructor_service._looks_like_image("board.bin", "image/png") is True
  assert constructor_service._looks_like_image("notes.txt", None) is False


def test_classify_task_uses_local_experience_and_keeps_openai_as_review(tmp_path: Path, monkeypatch):
  client = FakeOpenAIClient(
    response_outputs=[
      QuadrantClassification(quadrant=0, confidence=0.94, reasoning="Client deadline is urgent and important.")
    ]
  )
  service = build_service(tmp_path, openai_client=client)
  service._last_similarity_mode = "embeddings"
  monkeypatch.setattr(
    service,
    "find_similar_examples",
    lambda task, limit=3: [SimilarExample(text="Urgent deadline", quadrant=0, source="feedback", score=0.91)],
  )

  result = service.classify_task("Urgent client deadline")

  assert result["method"] == "experience-embeddings"
  assert result["quadrant"] == 0
  assert result["urgent"] is True
  assert result["important"] is True
  assert result["similar_examples_used"] == 1
  assert result["rag_influence"] == "experience-embeddings"
  assert result["top_similar_examples"][0]["quadrant_name"] == "Do Now"
  assert result["model_review"]["method"] == "openai-responses"
  assert result["model_review"]["quadrant"] == 0
  assert client.responses.calls[0]["model"] == "gpt-4o-mini"


def test_classify_and_analyze_stay_local_when_openai_errors(tmp_path: Path, monkeypatch):
  service = build_service(tmp_path, openai_client=object())
  monkeypatch.setattr(
    service,
    "find_similar_examples",
    lambda task, limit=3: [SimilarExample(text="Urgent outage", quadrant=0, source="user", score=0.6)],
  )
  monkeypatch.setattr(service, "_classify_with_openai", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("nope")))

  classification = service.classify_task("Urgent outage")
  assert classification["method"] == "experience-lexical"
  assert classification["rag_influence"] == "experience-lexical"
  assert classification["similar_examples_used"] == 1
  assert "model_review" not in classification

  rag = {
    "quadrant": 1,
    "quadrant_name": "Schedule",
    "confidence": 0.75,
  }
  monkeypatch.setattr(service, "classify_task", lambda task, use_rag=True: {"task": task, **rag})
  monkeypatch.setattr(
    service,
    "_analyze_with_openai",
    lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("offline")),
  )

  analysis = service.analyze_with_reasoning("Prepare roadmap", language="pl")
  assert analysis["langchain_analysis"]["method"] == "lazy-langchain"
  assert analysis["langchain_analysis"]["reasoning"].startswith("Kwadrant")
  assert analysis["rag_classification"]["quadrant_name"] == "Deleguj"


def test_classify_task_uses_rules_as_primary_when_no_example_matches(tmp_path: Path, monkeypatch):
  service = build_service(tmp_path)
  monkeypatch.setattr(service, "find_similar_examples", lambda task, limit=3: [])

  result = service.classify_task("Urgent client deadline")

  assert result["method"] == "rules-primary"
  assert result["rag_influence"] == "rules-prior"
  assert result["quadrant"] == 0
  assert result["similar_examples_used"] == 0


def test_analyze_with_reasoning_uses_openai_when_available(tmp_path: Path, monkeypatch):
  client = FakeOpenAIClient(
    response_outputs=[
      QuadrantClassification(quadrant=1, confidence=0.82, reasoning="Needs protected time."),
      AdvancedQuadrantAnalysis(
        quadrant=None,
        confidence=0.88,
        reasoning="Klasyfikacja do kwadrantu 1 jest uzasadniona.",
      ),
    ]
  )
  service = build_service(tmp_path, openai_client=client)
  monkeypatch.setattr(
    service,
    "find_similar_examples",
    lambda task, limit=3: [SimilarExample(text="Prepare roadmap", quadrant=1, source="seed", score=0.77)],
  )

  analysis = service.analyze_with_reasoning("Prepare roadmap", language="pl")

  assert analysis["langchain_analysis"]["method"] == "openai-reasoning"
  assert analysis["langchain_analysis"]["reasoning"] == "Klasyfikacja do kwadrantu „Zaplanuj” jest uzasadniona."
  assert analysis["rag_classification"]["quadrant_name"] == "Zaplanuj"
  assert analysis["rag_classification"]["quadrant"] == 1
  assert analysis["comparison"]["methods_agree"] is True
  assert client.responses.calls[1]["model"] == "gpt-4o-mini"
  assert "Return the reasoning in Polish." in client.responses.calls[1]["instructions"]
  assert "(Zaplanuj)" in client.responses.calls[1]["input"][0]["content"][0]["text"]


def test_extract_tasks_from_image_variants(tmp_path: Path, monkeypatch):
  plain_text_service = build_service(tmp_path)
  plain_text = plain_text_service.extract_tasks_from_image(
    "tasks.txt",
    b"urgent outage\nprepare roadmap\n",
    "text/plain",
  )
  assert plain_text["ocr"]["method"] == "plain-text"
  assert plain_text["summary"]["total_tasks"] == 2

  vision_service = build_service(tmp_path, openai_client=object())
  monkeypatch.setattr(vision_service, "_tesseract_available", lambda: False)
  monkeypatch.setattr(vision_service, "_extract_tasks_with_openai", lambda *args: ["urgent outage", "plan roadmap"])
  vision_result = vision_service.extract_tasks_from_image("board.png", png_payload(), "image/png")
  assert vision_result["ocr"]["method"] == "openai-vision"
  assert vision_result["ocr"]["raw_tasks_detected"] == 2

  tesseract_service = build_service(tmp_path, openai_client=object())
  monkeypatch.setattr(
    tesseract_service,
    "_extract_tasks_with_openai",
    lambda *args: (_ for _ in ()).throw(RuntimeError("vision failed")),
  )
  monkeypatch.setattr(tesseract_service, "_tesseract_available", lambda: True)
  monkeypatch.setattr(
    tesseract_service,
    "_extract_tasks_with_tesseract",
    lambda payload: (["urgent outage"], "urgent outage"),
  )
  tesseract_result = tesseract_service.extract_tasks_from_image("scan.png", png_payload(), "image/png")
  assert tesseract_result["ocr"]["method"] == "tesseract"

  fallback_service = build_service(tmp_path, openai_client=object())
  monkeypatch.setattr(
    fallback_service,
    "_extract_tasks_with_openai",
    lambda *args: (_ for _ in ()).throw(RuntimeError("vision failed")),
  )
  monkeypatch.setattr(fallback_service, "_tesseract_available", lambda: True)
  monkeypatch.setattr(
    fallback_service,
    "_extract_tasks_with_tesseract",
    lambda payload: (_ for _ in ()).throw(RuntimeError("ocr failed")),
  )
  fallback_result = fallback_service.extract_tasks_from_image("follow-up-plan.png", png_payload(), "image/png")
  assert fallback_result["ocr"]["method"] == "filename-fallback"
  assert fallback_result["ocr"]["extracted_text"] == "follow up plan"
  assert fallback_result["classified_tasks"][0]["text"] == "follow up plan"


def test_private_openai_and_ocr_helpers(tmp_path: Path):
  openai_service = build_service(
    tmp_path,
    openai_client=FakeOpenAIClient(
      response_outputs=[
        ExtractedTasksPayload(tasks=["task one", "Task one", "task two"]),
        None,
      ]
    ),
  )
  extracted = openai_service._extract_tasks_with_openai("board.png", b"abc", "image/png")
  assert extracted == ["task one", "task two"]

  try:
    openai_service._extract_tasks_with_openai("board.png", b"abc", "image/png")
  except ValueError as issue:
    assert "structured output" in str(issue)
  else:
    raise AssertionError("Expected ValueError when image extraction has no structured output")

  classify_service = build_service(
    tmp_path / "classify-none",
    openai_client=FakeOpenAIClient(response_outputs=[None]),
  )
  try:
    classify_service._classify_with_openai("Urgent outage", [])
  except ValueError as issue:
    assert "structured output" in str(issue)
  else:
    raise AssertionError("Expected ValueError when classification has no structured output")

  analyze_service = build_service(
    tmp_path / "analyze-none",
    openai_client=FakeOpenAIClient(response_outputs=[None]),
  )
  try:
    analyze_service._analyze_with_openai(
      "Prepare roadmap",
      {"quadrant": 1, "quadrant_name": "Schedule", "confidence": 0.7},
      [],
    )
  except ValueError as issue:
    assert "structured reasoning" in str(issue)
  else:
    raise AssertionError("Expected ValueError when analysis has no structured output")

  tesseract_service = build_service(
    tmp_path,
    ocr_runner=lambda image, lang: "urgent outage\nurgent outage\nplan roadmap",
  )
  tasks, text = tesseract_service._extract_tasks_with_tesseract(png_payload())
  assert tasks == ["urgent outage", "plan roadmap"]
  assert "urgent outage" in text


def test_rebuild_retrain_and_similarity_index_cover_embedding_paths(tmp_path: Path):
  store = TrainingStore(tmp_path / "training.json")
  store.save(
    [
      {"text": "Urgent outage", "quadrant": 0, "source": "feedback"},
      {"text": "Plan roadmap", "quadrant": 1, "source": "user"},
    ]
  )
  client = FakeOpenAIClient(embedding_batches=[[[1.0, 0.0], [0.0, 1.0]], [[1.0, 0.0]]])
  service = QuadrantAIService(
    settings=Settings(
      training_data_path=tmp_path / "training.json",
      model_cache_dir=tmp_path / "runtime",
    ),
    store=store,
    fallback_classifier=HeuristicClassifier(),
    openai_client=client,
  )

  cache = service.rebuild_experience_index(preserve_experience=False)
  assert cache["similarity_mode"] == "embeddings"
  assert service.index_path.exists()

  index = service._load_index()
  assert index is not None
  assert service._existing_embeddings(None) == {}
  assert len(service._existing_embeddings(index)) == 2

  similar = service.find_similar_examples("Urgent outage now", limit=1)
  assert similar[0].text == "Urgent outage"
  assert client.embeddings.calls[0]["model"] == "text-embedding-3-small"

  scored = service._score_examples_with_embeddings(index, [1.0, 0.0], limit=1)
  assert scored[0].quadrant == 0

  lexical = service._score_examples_lexically(store.load(), "plan roadmap review", limit=2)
  assert lexical[0].text == "Plan roadmap"

  retrain = service.retrain(preserve_experience=True)
  assert retrain["status"] == "completed"
  assert retrain["preserve_experience"] is True
  assert retrain["indexed_examples"] == 2


def test_index_error_paths_and_low_level_helpers(tmp_path: Path, monkeypatch):
  store = TrainingStore(tmp_path / "training.json")
  store.save([{"text": "Urgent outage", "quadrant": 0, "source": "feedback"}])
  service = QuadrantAIService(
    settings=Settings(
      training_data_path=tmp_path / "training.json",
      model_cache_dir=tmp_path / "runtime",
    ),
    store=store,
    fallback_classifier=HeuristicClassifier(),
    openai_client=object(),
  )
  monkeypatch.setattr(service, "_embed_texts", lambda texts: (_ for _ in ()).throw(RuntimeError("embeddings failed")))

  cache = service.rebuild_experience_index()
  assert cache["similarity_mode"] == "lexical"

  service.index_path.write_text("{invalid json", encoding="utf-8")
  assert service._load_index() is None
  assert service._existing_embeddings({"items": [{"text": "Urgent outage", "quadrant": 0, "embedding": None}]}) == {}

  keyed = service._cache_key({"text": "Urgent outage", "quadrant": 0})
  assert keyed == "Urgent outage::0::unknown"
  assert service._build_signature(store.load())

  empty_store = TrainingStore(tmp_path / "empty.json")
  empty_store.save([])
  empty_service = QuadrantAIService(
    settings=Settings(
      training_data_path=tmp_path / "empty.json",
      model_cache_dir=tmp_path / "empty-runtime",
    ),
    store=empty_store,
    fallback_classifier=HeuristicClassifier(),
  )
  assert empty_service.find_similar_examples("anything") == []

  missing_index_service = build_service(tmp_path / "missing-index")
  missing_index_service.store.save([{"text": "Urgent outage", "quadrant": 0, "source": "feedback"}])
  load_states = iter([None, None])
  monkeypatch.setattr(missing_index_service, "_load_index", lambda: next(load_states))
  monkeypatch.setattr(missing_index_service, "rebuild_experience_index", lambda preserve_experience=True: {"similarity_mode": "lexical"})
  assert missing_index_service.find_similar_examples("Urgent outage") == []

  lexical_fallback_service = QuadrantAIService(
    settings=Settings(
      training_data_path=tmp_path / "lexical.json",
      model_cache_dir=tmp_path / "lexical-runtime",
    ),
    store=TrainingStore(tmp_path / "lexical.json"),
    fallback_classifier=HeuristicClassifier(),
    openai_client=object(),
  )
  lexical_fallback_service.store.save([{"text": "Urgent outage", "quadrant": 0, "source": "feedback"}])
  signature = lexical_fallback_service._build_signature(lexical_fallback_service.store.load())
  lexical_fallback_service.index_path.write_text(
    '{"signature": "%s", "similarity_mode": "embeddings", "items": [{"text": "Urgent outage", "quadrant": 0, "source": "feedback", "embedding": [1.0, 0.0]}]}' % signature,
    encoding="utf-8",
  )
  monkeypatch.setattr(
    lexical_fallback_service,
    "_embed_texts",
    lambda texts: (_ for _ in ()).throw(RuntimeError("query embeddings failed")),
  )
  similar = lexical_fallback_service.find_similar_examples("Urgent outage now", limit=1)
  assert similar[0].text == "Urgent outage"

  embedding_scores = lexical_fallback_service._score_examples_with_embeddings(
    {
      "items": [
        {"text": "Urgent outage", "quadrant": 0, "source": "feedback", "embedding": [1.0, 0.0]},
        {"text": "No vector", "quadrant": 3, "source": "seed", "embedding": None},
      ]
    },
    [1.0, 0.0],
    limit=5,
  )
  assert len(embedding_scores) == 1

  monkeypatch.setattr("app.service.shutil.which", lambda name: "/usr/bin/tesseract")
  assert lexical_fallback_service._tesseract_available() is True
