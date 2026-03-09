from __future__ import annotations

from base64 import b64encode
from dataclasses import dataclass
from hashlib import sha256
from io import BytesIO
from pathlib import Path
import json
import math
import mimetypes
import re
import shutil
from typing import Any

from openai import OpenAI
from PIL import Image
from pydantic import BaseModel, Field
import pytesseract

from .classifier import HeuristicClassifier, utc_now
from .config import Settings
from .defaults import QUADRANT_NAMES, get_quadrant_name, normalize_language
from .store import TrainingStore


class QuadrantClassification(BaseModel):
  quadrant: int = Field(ge=0, le=3)
  confidence: float = Field(ge=0, le=1)
  reasoning: str


class AdvancedQuadrantAnalysis(BaseModel):
  quadrant: int | None = Field(default=None, ge=0, le=3)
  confidence: float = Field(ge=0, le=1)
  reasoning: str


class ExtractedTasksPayload(BaseModel):
  tasks: list[str] = Field(default_factory=list)


@dataclass(frozen=True)
class SimilarExample:
  text: str
  quadrant: int
  source: str
  score: float

  def to_dict(self) -> dict[str, Any]:
    return {
      "text": self.text,
      "quadrant": self.quadrant,
      "quadrant_name": QUADRANT_NAMES[self.quadrant],
      "source": self.source,
      "score": round(self.score, 4),
    }


def quadrant_to_flags(quadrant: int) -> tuple[bool, bool]:
  return quadrant in {0, 1}, quadrant in {0, 2}


def normalize_extracted_tasks(tasks: list[str]) -> list[str]:
  seen: set[str] = set()
  normalized: list[str] = []

  for task in tasks:
    cleaned = re.sub(r"\s+", " ", task).strip(" -\t\r\n")
    if not cleaned:
      continue
    lowered = cleaned.lower()
    if lowered in seen:
      continue
    seen.add(lowered)
    normalized.append(cleaned)

  return normalized[:10]


def cosine_similarity(left: list[float], right: list[float]) -> float:
  left_norm = math.sqrt(sum(value * value for value in left))
  right_norm = math.sqrt(sum(value * value for value in right))
  if left_norm == 0 or right_norm == 0:
    return 0.0

  dot = sum(left_value * right_value for left_value, right_value in zip(left, right))
  return dot / (left_norm * right_norm)


def lexical_similarity(query: str, candidate: str) -> float:
  query_tokens = {token for token in re.split(r"[^a-zA-Z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]+", query.lower()) if token}
  candidate_tokens = {token for token in re.split(r"[^a-zA-Z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]+", candidate.lower()) if token}
  if not query_tokens or not candidate_tokens:
    return 0.0

  overlap = len(query_tokens & candidate_tokens)
  universe = len(query_tokens | candidate_tokens)
  return overlap / universe if universe else 0.0


def localize_reasoning_quadrant_reference(
  reasoning: str,
  quadrant: int | None,
  language: str = "en",
) -> str:
  if quadrant is None:
    return reasoning

  quadrant_name = get_quadrant_name(quadrant, language)
  replacements = (
    (f"Quadrant {quadrant}", f'"{quadrant_name}" quadrant'),
    (f"quadrant {quadrant}", f'quadrant "{quadrant_name}"'),
    (f"Kwadrantu {quadrant}", f'Kwadrantu „{quadrant_name}”'),
    (f"kwadrantu {quadrant}", f'kwadrantu „{quadrant_name}”'),
    (f"Kwadrancie {quadrant}", f'Kwadrancie „{quadrant_name}”'),
    (f"kwadrancie {quadrant}", f'kwadrancie „{quadrant_name}”'),
    (f"Kwadrant {quadrant}", f'Kwadrant „{quadrant_name}”'),
    (f"kwadrant {quadrant}", f'kwadrant „{quadrant_name}”'),
  )

  localized_reasoning = reasoning
  for source, target in replacements:
    localized_reasoning = localized_reasoning.replace(source, target)

  localized_reasoning = localized_reasoning.replace(
    f'„{quadrant_name}” ({quadrant_name})',
    f'„{quadrant_name}”',
  )
  localized_reasoning = localized_reasoning.replace(
    f'"{quadrant_name}" ({quadrant_name})',
    f'"{quadrant_name}"',
  )

  return localized_reasoning


class QuadrantAIService:
  def __init__(
    self,
    settings: Settings,
    store: TrainingStore,
    fallback_classifier: HeuristicClassifier | None = None,
    openai_client: OpenAI | None = None,
    ocr_runner: Any | None = None,
  ):
    self.settings = settings
    self.store = store
    self.fallback_classifier = fallback_classifier or HeuristicClassifier()
    self.settings.model_cache_dir.mkdir(parents=True, exist_ok=True)
    self.index_path = self.settings.model_cache_dir / "experience_index.json"
    self.ocr_runner = ocr_runner or pytesseract.image_to_string
    self._last_similarity_mode = "lexical"

    if openai_client is not None:
      self.openai_client = openai_client
    elif settings.openai_api_key:
      self.openai_client = OpenAI(
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
        timeout=settings.openai_timeout_seconds,
      )
    else:
      self.openai_client = None

  def capabilities(self) -> dict[str, Any]:
    openai_enabled = self.openai_client is not None
    tesseract_enabled = self._tesseract_available()

    return {
      "classification": True,
      "langchain_analysis": True,
      "ocr": openai_enabled or tesseract_enabled,
      "batch_analysis": True,
      "training_management": True,
      "providers": {
        "openai": openai_enabled,
        "embeddings": openai_enabled,
        "vector_db": False,
        "langchain": False,
        "vision": openai_enabled,
        "tesseract": tesseract_enabled,
        "ocr": openai_enabled or tesseract_enabled,
      },
    }

  def classify_task(self, task: str, use_rag: bool = True) -> dict[str, Any]:
    similar_examples = self.find_similar_examples(task, limit=3) if use_rag else []
    result = self._classify_with_local_experience(
      task,
      similar_examples,
      self._last_similarity_mode if use_rag else "rules",
    )

    if self.openai_client is not None:
      try:
        decision = self._classify_with_openai(task, similar_examples if use_rag else [])
        result["model_review"] = {
          "quadrant": decision.quadrant,
          "quadrant_name": QUADRANT_NAMES[decision.quadrant],
          "confidence": decision.confidence,
          "reasoning": decision.reasoning,
          "method": "openai-responses",
        }
      except Exception:
        pass

    return result

  def analyze_with_reasoning(self, task: str, language: str = "en") -> dict[str, Any]:
    resolved_language = normalize_language(language)
    rag = self.classify_task(task, use_rag=True)
    similar_examples = self.find_similar_examples(task, limit=4)

    if self.openai_client is not None:
      try:
        analysis = self._analyze_with_openai(task, rag, similar_examples, resolved_language)
        resolved_quadrant = analysis.quadrant if analysis.quadrant is not None else rag["quadrant"]
        return {
          "task": task,
          "langchain_analysis": {
            "quadrant": analysis.quadrant,
            "reasoning": localize_reasoning_quadrant_reference(
              analysis.reasoning,
              resolved_quadrant,
              resolved_language,
            ),
            "confidence": analysis.confidence,
            "method": "openai-reasoning",
          },
          "rag_classification": {
            "quadrant": rag["quadrant"],
            "quadrant_name": get_quadrant_name(rag["quadrant"], resolved_language),
            "confidence": rag["confidence"],
          },
          "comparison": {
            "methods_agree": resolved_quadrant == rag["quadrant"],
            "confidence_difference": round(abs(analysis.confidence - rag["confidence"]), 2),
          },
          "timestamp": utc_now(),
        }
      except Exception:
        pass

    return self.fallback_classifier.analyze_with_langchain(task, language=resolved_language)

  def batch_analyze(self, tasks: list[str]) -> dict[str, Any]:
    batch_results = []
    method_summary = {
      "rag": {"quadrant_distribution": {str(index): 0 for index in QUADRANT_NAMES}},
      "langchain": {"quadrant_distribution": {str(index): 0 for index in QUADRANT_NAMES}},
    }

    for task in tasks:
      rag = self.classify_task(task)
      analysis = self.analyze_with_reasoning(task)["langchain_analysis"]
      rag_quadrant = rag["quadrant"]
      analysis_quadrant = analysis["quadrant"] if analysis["quadrant"] is not None else rag_quadrant

      method_summary["rag"]["quadrant_distribution"][str(rag_quadrant)] += 1
      method_summary["langchain"]["quadrant_distribution"][str(analysis_quadrant)] += 1
      batch_results.append(
        {
          "task": task,
          "analyses": {
            "rag": rag,
            "langchain": analysis,
          },
        }
      )

    return {
      "batch_results": batch_results,
      "summary": {
        "methods": method_summary,
        "total_tasks": len(tasks),
      },
      "timestamp": utc_now(),
    }

  def extract_tasks_from_image(
    self,
    filename: str,
    payload: bytes,
    content_type: str | None = None,
  ) -> dict[str, Any]:
    extracted_text = ""
    tasks: list[str] = []
    method = "filename-fallback"

    if content_type == "text/plain" or filename.lower().endswith(".txt"):
      extracted_text = payload.decode("utf-8", errors="ignore")
      tasks = normalize_extracted_tasks(extracted_text.splitlines())
      method = "plain-text"
    elif self.openai_client is not None and self._looks_like_image(filename, content_type):
      try:
        tasks = self._extract_tasks_with_openai(filename, payload, content_type)
        extracted_text = "\n".join(tasks)
        method = "openai-vision"
      except Exception:
        tasks = []

    if not tasks and self._looks_like_image(filename, content_type) and self._tesseract_available():
      try:
        tasks, extracted_text = self._extract_tasks_with_tesseract(payload)
        method = "tesseract"
      except Exception:
        tasks = []

    if not tasks:
      fallback_name = filename.rsplit(".", 1)[0].replace("-", " ").strip() if filename else ""
      tasks = normalize_extracted_tasks([fallback_name]) if fallback_name else []
      if not extracted_text:
        extracted_text = fallback_name

    classified = []
    for task in tasks[:10]:
      classification = self.classify_task(task)
      classified.append(
        {
          "text": task,
          "quadrant": classification["quadrant"],
          "quadrant_name": classification["quadrant_name"],
          "confidence": classification["confidence"],
        }
      )

    counts = {index: 0 for index in QUADRANT_NAMES}
    for item in classified:
      counts[item["quadrant"]] += 1

    total = len(classified) or 1
    return {
      "filename": filename,
      "image_info": {
        "size_bytes": len(payload),
        "shape": "unknown",
      },
      "ocr": {
        "extracted_text": extracted_text,
        "raw_tasks_detected": len(tasks),
        "method": method,
      },
      "classified_tasks": classified,
      "summary": {
        "total_tasks": len(classified),
        "quadrant_distribution": {
          "counts": counts,
          "percentages": {key: round((value / total) * 100, 2) for key, value in counts.items()},
          "quadrant_names": QUADRANT_NAMES,
        },
      },
      "timestamp": utc_now(),
    }

  def retrain(self, preserve_experience: bool = True) -> dict[str, Any]:
    cache = self.rebuild_experience_index(preserve_experience=preserve_experience)
    return {
      "message": "Experience index rebuilt.",
      "preserve_experience": preserve_experience,
      "status": "completed",
      **cache,
    }

  def rebuild_experience_index(self, preserve_experience: bool = True) -> dict[str, Any]:
    records = self.store.load()
    signature = self._build_signature(records)
    existing = self._load_index() if preserve_experience else None
    existing_embeddings = self._existing_embeddings(existing)

    items = []
    missing_inputs: list[str] = []
    missing_keys: list[str] = []

    for record in records:
      key = self._cache_key(record)
      embedding = existing_embeddings.get(key)
      item = {
        "text": record["text"],
        "quadrant": record["quadrant"],
        "source": record.get("source", "unknown"),
        "embedding": embedding,
      }
      items.append(item)
      if embedding is None and self.openai_client is not None:
        missing_inputs.append(record["text"])
        missing_keys.append(key)

    if missing_inputs and self.openai_client is not None:
      try:
        embeddings = self._embed_texts(missing_inputs)
      except Exception:
        embeddings = []
      if len(embeddings) == len(missing_keys):
        embedding_lookup = dict(zip(missing_keys, embeddings))
        for item in items:
          key = self._cache_key(item)
          if key in embedding_lookup:
            item["embedding"] = embedding_lookup[key]

    similarity_mode = "embeddings" if any(item["embedding"] is not None for item in items) else "lexical"
    payload = {
      "signature": signature,
      "updated_at": utc_now(),
      "embedding_model": self.settings.openai_embedding_model if similarity_mode == "embeddings" else None,
      "similarity_mode": similarity_mode,
      "items": items,
    }
    self.index_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    return {
      "indexed_examples": len(items),
      "cache_path": str(self.index_path),
      "similarity_mode": similarity_mode,
    }

  def find_similar_examples(self, task: str, limit: int = 3) -> list[SimilarExample]:
    records = self.store.load()
    if not records:
      self._last_similarity_mode = "lexical"
      return []

    index = self._load_index()
    signature = self._build_signature(records)
    if index is None or index.get("signature") != signature:
      cache = self.rebuild_experience_index()
      index = self._load_index()
      if index is None:
        self._last_similarity_mode = "lexical"
        return []
      index["similarity_mode"] = cache["similarity_mode"]

    if self.openai_client is not None and index.get("similarity_mode") == "embeddings":
      try:
        query_embedding = self._embed_texts([task])[0]
        self._last_similarity_mode = "embeddings"
        return self._score_examples_with_embeddings(index, query_embedding, limit)
      except Exception:
        pass

    self._last_similarity_mode = "lexical"
    return self._score_examples_lexically(records, task, limit)

  def _classify_with_local_experience(
    self,
    task: str,
    similar_examples: list[SimilarExample],
    similarity_mode: str,
  ) -> dict[str, Any]:
    heuristic = self.fallback_classifier.classify_task(task, use_rag=bool(similar_examples))
    scores = {index: 0.0 for index in QUADRANT_NAMES}
    positive_examples = [match for match in similar_examples if match.score > 0]

    for match in positive_examples:
      source_bonus = 1.15 if match.source == "feedback" else 1.0
      scores[match.quadrant] += match.score * source_bonus

    heuristic_quadrant = heuristic["quadrant"]
    heuristic_weight = max(heuristic["confidence"], 0.5) * 0.35
    scores[heuristic_quadrant] += heuristic_weight

    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    quadrant, winner_score = ranked[0]
    runner_up_score = ranked[1][1] if len(ranked) > 1 else 0.0

    total_score = sum(scores.values())
    evidence_score = sum(match.score for match in positive_examples)
    margin = max(winner_score - runner_up_score, 0.0)

    if positive_examples:
      confidence = min(0.58 + min(evidence_score, 2.5) * 0.12 + min(margin, 1.0) * 0.2, 0.97)
      method = "experience-embeddings" if similarity_mode == "embeddings" else "experience-lexical"
      rag_influence = method
    else:
      confidence = max(heuristic["confidence"], 0.64)
      method = "rules-primary"
      rag_influence = "rules-prior"

    urgent, important = quadrant_to_flags(quadrant)
    return {
      "task": task,
      "urgent": urgent,
      "important": important,
      "quadrant": quadrant,
      "quadrant_name": QUADRANT_NAMES[quadrant],
      "timestamp": utc_now(),
      "method": method,
      "confidence": round(confidence, 4),
      "rag_influence": rag_influence,
      "similar_examples_used": len(positive_examples),
      "top_similar_examples": [match.to_dict() for match in positive_examples[:3]],
      "local_scores": {
        str(index): round(score / total_score, 4) if total_score else 0.0
        for index, score in scores.items()
      },
    }

  def _classify_with_openai(
    self,
    task: str,
    similar_examples: list[SimilarExample],
  ) -> QuadrantClassification:
    response = self.openai_client.responses.parse(
      model=self.settings.openai_classification_model,
      instructions=(
        "Classify the task into the Eisenhower Matrix. "
        "Use quadrant mapping: 0=Do Now, 1=Schedule, 2=Delegate, 3=Delete. "
        "Return a concise rationale grounded in urgency and importance."
      ),
      input=self._build_text_input(task, similar_examples),
      text_format=QuadrantClassification,
      temperature=0,
      max_output_tokens=220,
    )
    parsed = response.output_parsed
    if parsed is None:
      raise ValueError("OpenAI response did not return structured output")
    return parsed

  def _analyze_with_openai(
    self,
    task: str,
    rag_classification: dict[str, Any],
    similar_examples: list[SimilarExample],
    language: str = "en",
  ) -> AdvancedQuadrantAnalysis:
    resolved_language = normalize_language(language)
    localized_quadrant_name = get_quadrant_name(rag_classification["quadrant"], resolved_language)
    response_language = "Polish" if resolved_language == "pl" else "English"
    prompt = (
      f"Task: {task}\n"
      f"Current classification: quadrant {rag_classification['quadrant']} ({localized_quadrant_name})\n"
      f"Current confidence: {rag_classification['confidence']}\n"
      f"Explain the decision in 2-4 sentences and confirm the best quadrant. Write the reasoning in {response_language}."
    )
    response = self.openai_client.responses.parse(
      model=self.settings.openai_reasoning_model,
      instructions=(
        "Produce a deeper Eisenhower Matrix analysis. "
        "If the task is ambiguous you may leave quadrant null, but prefer a concrete quadrant when the evidence is clear. "
        f"Return the reasoning in {response_language}."
      ),
      input=self._build_text_input(prompt, similar_examples, resolved_language),
      text_format=AdvancedQuadrantAnalysis,
      temperature=0.2,
      max_output_tokens=320,
    )
    parsed = response.output_parsed
    if parsed is None:
      raise ValueError("OpenAI response did not return structured reasoning")
    return parsed

  def _extract_tasks_with_openai(
    self,
    filename: str,
    payload: bytes,
    content_type: str | None,
  ) -> list[str]:
    mime_type = content_type or mimetypes.guess_type(filename)[0] or "image/png"
    image_url = f"data:{mime_type};base64,{b64encode(payload).decode('utf-8')}"
    response = self.openai_client.responses.parse(
      model=self.settings.openai_vision_model,
      instructions=(
        "Extract a clean task list from the image. "
        "Return short standalone task descriptions without numbering."
      ),
      input=[
        {
          "role": "user",
          "content": [
            {"type": "input_text", "text": "Extract the actionable tasks visible in this image."},
            {"type": "input_image", "image_url": image_url},
          ],
        }
      ],
      text_format=ExtractedTasksPayload,
      temperature=0,
      max_output_tokens=300,
    )
    parsed = response.output_parsed
    if parsed is None:
      raise ValueError("OpenAI image extraction returned no structured output")
    return normalize_extracted_tasks(parsed.tasks)

  def _extract_tasks_with_tesseract(self, payload: bytes) -> tuple[list[str], str]:
    image = Image.open(BytesIO(payload))
    extracted_text = self.ocr_runner(image, lang=self.settings.tesseract_languages)
    return normalize_extracted_tasks(extracted_text.splitlines()), extracted_text

  def _build_text_input(
    self,
    task: str,
    similar_examples: list[SimilarExample],
    language: str = "en",
  ) -> list[dict[str, Any]]:
    resolved_language = normalize_language(language)
    if similar_examples:
      experience_block = "\n".join(
        f"- {item.text} -> {get_quadrant_name(item.quadrant, resolved_language)} "
        f"(score={item.score:.2f}, source={item.source})"
        for item in similar_examples
      )
    else:
      experience_block = "- No directly similar prior examples."

    return [
      {
        "role": "user",
        "content": [
          {
            "type": "input_text",
            "text": (
              f"Task:\n{task}\n\n"
              f"Relevant prior examples:\n{experience_block}\n\n"
              "Use the prior examples as context, not as hard rules."
            ),
          }
        ],
      }
    ]

  def _embed_texts(self, texts: list[str]) -> list[list[float]]:
    response = self.openai_client.embeddings.create(
      model=self.settings.openai_embedding_model,
      input=texts,
      encoding_format="float",
    )
    return [item.embedding for item in response.data]

  def _score_examples_with_embeddings(
    self,
    index: dict[str, Any],
    query_embedding: list[float],
    limit: int,
  ) -> list[SimilarExample]:
    scored = []
    for item in index["items"]:
      embedding = item.get("embedding")
      if not embedding:
        continue
      scored.append(
        SimilarExample(
          text=item["text"],
          quadrant=item["quadrant"],
          source=item.get("source", "unknown"),
          score=cosine_similarity(query_embedding, embedding),
        )
      )

    scored.sort(key=lambda item: item.score, reverse=True)
    return scored[:limit]

  def _score_examples_lexically(
    self,
    records: list[dict[str, Any]],
    task: str,
    limit: int,
  ) -> list[SimilarExample]:
    scored = [
      SimilarExample(
        text=record["text"],
        quadrant=record["quadrant"],
        source=record.get("source", "unknown"),
        score=lexical_similarity(task, record["text"]),
      )
      for record in records
    ]
    scored = [item for item in scored if item.score > 0]
    scored.sort(key=lambda item: item.score, reverse=True)
    return scored[:limit]

  def _load_index(self) -> dict[str, Any] | None:
    if not self.index_path.exists():
      return None

    try:
      return json.loads(self.index_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
      return None

  def _existing_embeddings(self, index: dict[str, Any] | None) -> dict[str, list[float]]:
    if index is None:
      return {}

    existing = {}
    for item in index.get("items", []):
      embedding = item.get("embedding")
      if embedding is None:
        continue
      existing[self._cache_key(item)] = embedding
    return existing

  def _cache_key(self, record: dict[str, Any]) -> str:
    source = record.get("source", "unknown")
    return f"{record['text']}::{record['quadrant']}::{source}"

  def _build_signature(self, records: list[dict[str, Any]]) -> str:
    normalized = json.dumps(
      [
        {
          "text": record["text"],
          "quadrant": record["quadrant"],
          "source": record.get("source", "unknown"),
        }
        for record in records
      ],
      ensure_ascii=False,
      sort_keys=True,
    )
    return sha256(normalized.encode("utf-8")).hexdigest()

  def _looks_like_image(self, filename: str, content_type: str | None) -> bool:
    if content_type and content_type.startswith("image/"):
      return True

    guessed_type = mimetypes.guess_type(filename)[0]
    return bool(guessed_type and guessed_type.startswith("image/"))

  def _tesseract_available(self) -> bool:
    return shutil.which("tesseract") is not None
