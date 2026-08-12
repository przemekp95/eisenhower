from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class GoldenCase(BaseModel):
  model_config = ConfigDict(extra="forbid")

  dataset_version: str
  case_id: str
  tenant_id: str
  user_id: str
  project_ids: list[str] = Field(default_factory=list)
  query_project_id: str | None = Field(default=None, min_length=1, max_length=128)
  roles: list[str] = Field(default_factory=list)
  language: Literal["pl", "en"] = "pl"
  split: Literal["train", "dev", "holdout"] = "dev"
  task: str
  corpus_version: str = "synthetic-corpus-v1"
  index_version: str = "synthetic-index-v1"
  expected_urgent: bool | None = None
  expected_important: bool | None = None
  expected_quadrant: int | None = Field(default=None, ge=0, le=3)
  answerability: Literal["answerable", "no_answer"]
  relevant_document_ids: list[str] = Field(default_factory=list)
  forbidden_document_ids: list[str] = Field(default_factory=list)
  stale_document_ids: list[str] = Field(default_factory=list)
  expected_content_versions: dict[str, str] = Field(default_factory=dict)
  allowed_citation_ids: list[str] = Field(default_factory=list)
  forbidden_citation_ids: list[str] = Field(default_factory=list)
  allowed_facts: list[str] = Field(default_factory=list)
  allowed_evidence: list[str] = Field(default_factory=list)
  difficulty: Literal["basic", "edge", "adversarial"] = "edge"
  tags: list[str] = Field(min_length=1)

  @model_validator(mode="before")
  @classmethod
  def derive_expected_axes(cls, values):
    if isinstance(values, dict) and values.get("expected_quadrant") is not None:
      mapping = {
        0: (True, True),
        1: (True, False),
        2: (False, True),
        3: (False, False),
      }
      urgent, important = mapping[int(values["expected_quadrant"])]
      values = dict(values)
      values.setdefault("expected_urgent", urgent)
      values.setdefault("expected_important", important)
    return values

  @model_validator(mode="after")
  def validate_query_project(self):
    if self.query_project_id is not None and self.query_project_id not in self.project_ids:
      raise ValueError("query_project_id must belong to project_ids")
    return self


def load_golden_dataset(path: str | Path) -> list[GoldenCase]:
  source = Path(path)
  return parse_golden_dataset(source.read_text(encoding="utf-8"))


def parse_golden_dataset(content: str) -> list[GoldenCase]:
  cases = [
    GoldenCase.model_validate_json(line)
    for line in content.splitlines()
    if line.strip()
  ]
  if not cases:
    raise ValueError("Golden dataset must not be empty")
  if len({case.case_id for case in cases}) != len(cases):
    raise ValueError("Golden case ids must be unique")
  if len({case.dataset_version for case in cases}) != 1:
    raise ValueError("Golden records must use one immutable dataset version")
  return cases
