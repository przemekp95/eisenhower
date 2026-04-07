from __future__ import annotations
from typing import List, Dict, Optional, Any, Iterable, Callable
from uuid import UUID

from langchain_core.documents import Document
from langchain_core.vectorstores import VectorStore
from langchain_core.embeddings import Embeddings
from langchain_qdrant import QdrantVectorStore as LangChainQdrantStore

from .qdrant_client import QdrantVectorStore
from .config import QdrantConfig
from ..domain.events import (
    event_publisher,
    VectorItemAddedEvent,
    VectorCollectionCreatedEvent,
    VectorCollectionClearedEvent,
    DomainEvent
)


class EisenhowerEmbeddings(Embeddings):
    """
    DDD Embedding wrapper spełniający interfejs LangChain Embeddings
    Obsługuje cache i unieważnianie po zdarzeniach domenowych
    """
    def __init__(self, embedding_fn: Callable[[str], List[float]]):
        self._embedding_fn = embedding_fn
        self._cache: Dict[str, List[float]] = {}
        self._subscribe_events()

    def _subscribe_events(self) -> None:
        event_publisher.subscribe(self._handle_domain_event)

    def _handle_domain_event(self, event: DomainEvent) -> None:
        """Unieważnia cache po każdej zmianie w kolekcji wektorów"""
        if isinstance(event, (VectorItemAddedEvent, VectorCollectionClearedEvent, VectorCollectionCreatedEvent)):
            self._cache.clear()

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        results = []
        for text in texts:
            if text not in self._cache:
                self._cache[text] = self._embedding_fn(text)
            results.append(self._cache[text])
        return results

    def embed_query(self, text: str) -> List[float]:
        if text not in self._cache:
            self._cache[text] = self._embedding_fn(text)
        return self._cache[text]


class LangChainQdrantAdapter(VectorStore):
    """
    DDD Adapter łączący istniejący QdrantVectorStore z interfejsem LangChain VectorStore
    Zachowuje wszystkie istniejące zdarzenia domenowe oraz logikę biznesową
    """

    def __init__(
        self,
        native_store: QdrantVectorStore,
        embeddings: Embeddings,
        config: Optional[QdrantConfig] = None
    ):
        self._native_store = native_store
        self._embeddings = embeddings
        self.config = config or QdrantConfig.from_env()

        # Inicjalizacja oryginalnego klienta LangChain dla pełnej kompatybilności
        self._langchain_store = LangChainQdrantStore(
            client=self._native_store._client,
            collection_name=self.config.collection_name,
            embeddings=self._embeddings,
            content_payload_key="text",
            metadata_payload_key="metadata"
        )

    @property
    def embeddings(self) -> Embeddings:
        return self._embeddings

    def add_texts(
        self,
        texts: Iterable[str],
        metadatas: Optional[List[dict]] = None,
        **kwargs: Any
    ) -> List[str]:
        metadatas = metadatas or [{} for _ in texts]
        ids: List[str] = []

        for text, metadata in zip(texts, metadatas):
            vector = self._embeddings.embed_query(text)
            payload = {**metadata, "text": text}
            point_id = self._native_store.add_vector(vector, payload)
            ids.append(str(point_id))

        return ids

    def add_documents(self, documents: List[Document], **kwargs: Any) -> List[str]:
        texts = [doc.page_content for doc in documents]
        metadatas = [doc.metadata for doc in documents]
        return self.add_texts(texts, metadatas, **kwargs)

    def similarity_search(
        self,
        query: str,
        k: int = 4,
        filter: Optional[Dict[str, Any]] = None,
        **kwargs: Any
    ) -> List[Document]:
        query_vector = self._embeddings.embed_query(query)

        quadrant = filter.get("quadrant") if filter else None
        results = self._native_store.search(query_vector, limit=k, quadrant=quadrant)

        return [
            Document(
                page_content=res["payload"].get("text", ""),
                metadata={k: v for k, v in res["payload"].items() if k != "text"},
                id=res["id"]
            )
            for res in results
        ]

    def similarity_search_with_score(
        self,
        query: str,
        k: int = 4,
        filter: Optional[Dict[str, Any]] = None,
        **kwargs: Any
    ) -> List[tuple[Document, float]]:
        query_vector = self._embeddings.embed_query(query)

        quadrant = filter.get("quadrant") if filter else None
        results = self._native_store.search(query_vector, limit=k, quadrant=quadrant)

        return [
            (
                Document(
                    page_content=res["payload"].get("text", ""),
                    metadata={k: v for k, v in res["payload"].items() if k != "text"},
                    id=res["id"]
                ),
                res["score"]
            )
            for res in results
        ]

    @classmethod
    def from_texts(
        cls,
        texts: List[str],
        embedding: Embeddings,
        metadatas: Optional[List[dict]] = None,
        **kwargs: Any
    ) -> VectorStore:
        raise NotImplementedError(
            "Użyj konstruktora z istniejącym native_store dla zgodności z DDD"
        )

    def delete(self, ids: Optional[List[str]] = None, **kwargs: Any) -> Optional[bool]:
        raise NotImplementedError("Operacja usuwania zarządzana przez domenę")

    def max_marginal_relevance_search(
        self,
        query: str,
        k: int = 4,
        fetch_k: int = 20,
        lambda_mult: float = 0.5,
        filter: Optional[Dict[str, Any]] = None,
        **kwargs: Any
    ) -> List[Document]:
        return self._langchain_store.max_marginal_relevance_search(
            query, k=k, fetch_k=fetch_k, lambda_mult=lambda_mult, filter=filter, **kwargs
        )
