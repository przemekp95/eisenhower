from __future__ import annotations
from unittest.mock import Mock, MagicMock
import pytest

from langchain_core.documents import Document

from app.vector.langchain_adapter import EisenhowerEmbeddings, LangChainQdrantAdapter
from app.classification.retrieval_chain import QuadrantRetrievalQA, EisenhowerClassificationResult
from app.domain.events import event_publisher, VectorItemAddedEvent, VectorCollectionClearedEvent
from app.vector.qdrant_client import QdrantVectorStore
from app.defaults import QUADRANT_NAMES


@pytest.mark.unit
class TestEisenhowerEmbeddings:
    def test_embedding_caching(self):
        mock_fn = Mock(return_value=[0.1, 0.2, 0.3])
        embeddings = EisenhowerEmbeddings(mock_fn)

        # Pierwsze wywołanie - powinno wywołać funkcję
        result1 = embeddings.embed_query("test task")
        assert mock_fn.call_count == 1
        assert result1 == [0.1, 0.2, 0.3]

        # Drugie wywołanie tego samego tekstu - powinno użyć cache
        result2 = embeddings.embed_query("test task")
        assert mock_fn.call_count == 1
        assert result2 == result1

        # Inny tekst - nowe wywołanie
        embeddings.embed_query("other task")
        assert mock_fn.call_count == 2

    def test_cache_invalidation_on_domain_event(self):
        mock_fn = Mock(return_value=[0.1, 0.2, 0.3])
        embeddings = EisenhowerEmbeddings(mock_fn)

        embeddings.embed_query("test task")
        assert mock_fn.call_count == 1
        assert len(embeddings._cache) == 1

        # Wysłanie zdarzenia dodania elementu
        event_publisher.publish(VectorItemAddedEvent(payload={"point_id": "test-id"}))

        # Cache powinien być pusty
        assert len(embeddings._cache) == 0

        # Ponowne wywołanie powinno ponownie wywołać funkcję
        embeddings.embed_query("test task")
        assert mock_fn.call_count == 2


@pytest.mark.unit
class TestLangChainQdrantAdapter:
    def test_adapter_compliance_with_langchain_interface(self):
        native_store = Mock(spec=QdrantVectorStore)
        embeddings = Mock()
        embeddings.embed_query = Mock(return_value=[0.1, 0.2, 0.3])

        adapter = LangChainQdrantAdapter(native_store, embeddings)

        # Test zgodności z interfejsem VectorStore
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


@pytest.mark.unit
class TestQuadrantRetrievalQA:
    def test_chain_build_success(self):
        vector_store = Mock()
        vector_store.similarity_search = Mock(return_value=[
            Document(page_content="Napisz raport", metadata={"quadrant": 0}),
            Document(page_content="Spotkanie z klientem", metadata={"quadrant": 1}),
        ])
        vector_store.as_retriever = Mock(return_value=Mock())

        embeddings = Mock()
        chain = QuadrantRetrievalQA(vector_store, embeddings, top_k=2)

        assert chain is not None
        assert chain.top_k == 2
        assert hasattr(chain, "classify")

    def test_retriever_refresh_on_vector_events(self):
        vector_store = Mock()
        initial_retriever = Mock()
        vector_store.as_retriever = Mock(return_value=initial_retriever)

        chain = QuadrantRetrievalQA(vector_store, Mock())
        first_retriever = chain._retriever

        # Wywołaj zdarzenie dodania wektora
        event_publisher.publish(VectorItemAddedEvent(payload={"point_id": "abc123"}))

        # Powinien zostać utworzony nowy retriever
        assert vector_store.as_retriever.call_count == 2
        assert chain._retriever is not first_retriever
