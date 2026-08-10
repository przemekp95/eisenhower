from __future__ import annotations
from unittest.mock import Mock
import pytest

from langchain_core.documents import Document

from app.vector.langchain_adapter import EisenhowerEmbeddings, LangChainQdrantAdapter
from app.domain.events import event_publisher, VectorItemAddedEvent
from app.vector.qdrant_client import QdrantVectorStore


@pytest.mark.unit
class TestEisenhowerEmbeddings:
    def test_embedding_caching(self):
        mock_fn = Mock(return_value=[0.1, 0.2, 0.3])
        embeddings = EisenhowerEmbeddings(mock_fn)

        # The first call computes the embedding.
        result1 = embeddings.embed_query("test task")
        assert mock_fn.call_count == 1
        assert result1 == [0.1, 0.2, 0.3]

        # The second call for the same text uses the cache.
        result2 = embeddings.embed_query("test task")
        assert mock_fn.call_count == 1
        assert result2 == result1

        # A different text triggers another computation.
        embeddings.embed_query("other task")
        assert mock_fn.call_count == 2

    def test_cache_invalidation_on_domain_event(self):
        mock_fn = Mock(return_value=[0.1, 0.2, 0.3])
        embeddings = EisenhowerEmbeddings(mock_fn)

        embeddings.embed_query("test task")
        assert mock_fn.call_count == 1
        assert len(embeddings._cache) == 1

        # Publish an item-added event.
        event_publisher.publish(VectorItemAddedEvent(payload={"point_id": "test-id"}))

        # The event invalidates the cache.
        assert len(embeddings._cache) == 0

        # The next call computes the embedding again.
        embeddings.embed_query("test task")
        assert mock_fn.call_count == 2


@pytest.mark.unit
class TestLangChainQdrantAdapter:
    def test_adapter_compliance_with_langchain_interface(self):
        native_store = Mock(spec=QdrantVectorStore)
        embeddings = Mock()
        embeddings.embed_query = Mock(return_value=[0.1, 0.2, 0.3])

        adapter = LangChainQdrantAdapter(native_store, embeddings)

        # Verify compatibility with the VectorStore interface.
        assert hasattr(adapter, "similarity_search")
        assert hasattr(adapter, "add_texts")
        assert hasattr(adapter, "from_texts")

    def test_similarity_search_delegates_to_native_store(self):
        native_store = Mock(spec=QdrantVectorStore)
        embeddings = Mock()
        embeddings.embed_query = Mock(return_value=[0.5, 0.5, 0.5])

        native_store.search.return_value = [
            {
                "id": "123",
                "score": 0.92,
                "payload": {"text": "Kupić mleko", "quadrant": 2}
            }
        ]

        adapter = LangChainQdrantAdapter(native_store, embeddings)
        results = adapter.similarity_search("Kupić chleb", k=1)

        assert len(results) == 1
        assert isinstance(results[0], Document)
        assert results[0].page_content == "Kupić mleko"
        assert results[0].metadata["quadrant"] == 2
        native_store.search.assert_called_once_with([0.5, 0.5, 0.5], limit=1, quadrant=None)
