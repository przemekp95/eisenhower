from app.classifier import HeuristicClassifier, LazyProviders


def test_classifier_maps_urgent_and_important_tasks():
  classifier = HeuristicClassifier()
  result = classifier.classify_task("Urgent client deadline today")

  assert result["quadrant"] == 0
  assert result["urgent"] is True
  assert result["important"] is True


def test_classifier_handles_batch_and_capabilities():
  classifier = HeuristicClassifier(
    LazyProviders(
      embeddings_available=True,
      vector_db_available=False,
      langchain_available=True,
      ocr_available=True,
    )
  )

  batch = classifier.batch_analyze(["Check inbox", "Prepare strategic roadmap"])
  capabilities = classifier.capabilities()

  assert batch["summary"]["total_tasks"] == 2
  assert capabilities["providers"]["langchain"] is True


def test_classifier_extracts_tasks_from_utf8_payload():
  classifier = HeuristicClassifier()

  result = classifier.extract_tasks_from_image(
    "todo.txt",
    b"urgent deadline today\nprepare roadmap\n",
  )

  assert result["ocr"]["raw_tasks_detected"] == 2
  assert len(result["classified_tasks"]) == 2
