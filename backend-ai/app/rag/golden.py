from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class GoldenCase(BaseModel):
  model_config = ConfigDict(extra="forbid")

  dataset_version: str
  case_id: str
  tenant_id: str
  user_id: str
  project_ids: list[str] = Field(default_factory=list)
  roles: list[str] = Field(default_factory=list)
  language: Literal["pl", "en"] = "pl"
  task: str
  expected_quadrant: int | None = Field(default=None, ge=0, le=3)
  answerability: Literal["answerable", "no_answer"]
  relevant_document_ids: list[str] = Field(default_factory=list)
  forbidden_document_ids: list[str] = Field(default_factory=list)
  allowed_citation_ids: list[str] = Field(default_factory=list)
  tags: list[str] = Field(min_length=1)


def load_golden_dataset(path: str | Path) -> list[GoldenCase]:
  source = Path(path)
  cases = [
    GoldenCase.model_validate_json(line)
    for line in source.read_text(encoding="utf-8").splitlines()
    if line.strip()
  ]
  if not cases:
    raise ValueError("Golden dataset must not be empty")
  if len({case.case_id for case in cases}) != len(cases):
    raise ValueError("Golden case ids must be unique")
  if len({case.dataset_version for case in cases}) != 1:
    raise ValueError("Golden records must use one immutable dataset version")
  return cases
