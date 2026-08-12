from __future__ import annotations
from pathlib import Path
from collections import Counter
from typing import List, Dict, Optional
from sentence_transformers import SentenceTransformer

from .store import TrainingStore, utc_now
from .vector import QdrantVectorStore
from .defaults import DEFAULT_TRAINING_DATA, QUADRANT_NAMES


class QdrantTrainingStoreAdapter(TrainingStore):
    """
    Experimental adapter that preserves the TrainingStore interface while using Qdrant as the
    vector backend.
    """

    def __init__(self, path: Path, vector_store: Optional[QdrantVectorStore] = None):
        super().__init__(path)
        self.vector_store = vector_store or QdrantVectorStore()
        self._embedding_model = None

    @property
    def embedding_model(self):
        if self._embedding_model is None:
            self._embedding_model = SentenceTransformer("all-MiniLM-L6-v2")
        return self._embedding_model

    def embed_text(self, text: str) -> List[float]:
        return self.embedding_model.encode(text).tolist()

    def load(self) -> List[dict]:
        """Preserve compatibility by loading the local JSON file."""
        return super().load()

    def save(self, items: List[dict]) -> None:
        """Write to both the local file and Qdrant."""
        super().save(items)

        # Index new items in Qdrant.
        for item in items:
            if "id" not in item:
                vector = self.embed_text(item["text"])
                self.vector_store.add_vector(vector, item)

    def add_examples(self, records: List[dict]) -> List[dict]:
        saved = super().add_examples(records)

        vectors = [
            (self.embed_text(record["text"]), record)
            for record in saved
        ]

        if vectors:
            self.vector_store.add_vectors_batch(vectors)

        return saved

    def clear(self, keep_defaults: bool) -> List[dict]:
        cleared = super().clear(keep_defaults)
        self.vector_store.clear()

        if keep_defaults:
            vectors = [
                (self.embed_text(item["text"]), item)
                for item in cleared
            ]
            self.vector_store.add_vectors_batch(vectors)

        return cleared

    def search_similar(self, text: str, quadrant: Optional[int] = None, limit: int = 10) -> List[dict]:
        """Extend the store interface with semantic task search."""
        vector = self.embed_text(text)
        return self.vector_store.search(vector, limit=limit, quadrant=quadrant)

    def get_stats(self) -> dict:
        stats = super().get_stats()
        stats["vector_index_count"] = self.vector_store.count()
        stats["vector_store"] = "qdrant"
        return stats

    def migrate_existing_index(self) -> Dict[str, int]:
        """Migrate the complete existing local index to Qdrant."""
        return self.vector_store.migrate_from_local_store(self, self.embed_text)
