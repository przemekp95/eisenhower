from hashlib import sha256
from types import SimpleNamespace

import pytest
import torch

from app.rag.bge_m3_sparse import BgeM3SparseEmbeddingProvider


class FakeTokenizer:
  all_special_ids = [0, 1]

  def __call__(self, texts, **kwargs):
    assert kwargs == {
      "padding": True,
      "truncation": True,
      "max_length": 512,
      "return_tensors": "pt",
    }
    assert texts == ["alpha beta"]
    return {
      "input_ids": torch.tensor([[0, 10, 10, 20, 1]]),
      "attention_mask": torch.tensor([[1, 1, 1, 1, 1]]),
    }


class FakeEncoder(torch.nn.Module):
  def __init__(self):
    super().__init__()
    self.anchor = torch.nn.Parameter(torch.zeros(1))
    self.config = SimpleNamespace(hidden_size=2)

  def forward(self, **inputs):
    assert set(inputs) == {"input_ids", "attention_mask"}
    return SimpleNamespace(last_hidden_state=torch.tensor([[[0., 0.], [1., 0.], [2., 0.], [0., 3.], [0., 0.]]]))


class FakeTransformer:
  tokenizer = FakeTokenizer()
  auto_model = FakeEncoder()


class FakeSentenceTransformer:
  def __getitem__(self, index):
    assert index == 0
    return FakeTransformer()


def sparse_artifact(tmp_path):
  path = tmp_path / "sparse_linear.pt"
  torch.save({
    "weight": torch.tensor([[1.0, 1.0]]),
    "bias": torch.tensor([0.0]),
  }, path)
  return path


def test_bge_m3_sparse_provider_hash_verifies_and_keeps_max_weight_per_token(tmp_path):
  artifact = sparse_artifact(tmp_path)
  provider = BgeM3SparseEmbeddingProvider(
    FakeSentenceTransformer(),
    artifact_path=artifact,
    artifact_sha256=sha256(artifact.read_bytes()).hexdigest(),
    version="bge-m3-v1",
  )

  assert provider.embed_sparse(["alpha beta"]) == [{10: 2.0, 20: 3.0}]
  assert provider.version == "bge-m3-v1"


def test_bge_m3_sparse_provider_fails_closed_on_artifact_hash_mismatch(tmp_path):
  artifact = sparse_artifact(tmp_path)

  with pytest.raises(ValueError, match="hash mismatch"):
    BgeM3SparseEmbeddingProvider(
      FakeSentenceTransformer(),
      artifact_path=artifact,
      artifact_sha256="0" * 64,
      version="bge-m3-v1",
    )
