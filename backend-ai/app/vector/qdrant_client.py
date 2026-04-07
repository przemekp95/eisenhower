from __future__ import annotations
from typing import List, Dict, Optional, Any
from uuid import UUID, uuid4

from qdrant_client import QdrantClient as QdrantSdkClient
from qdrant_client.http.models import (
    Distance,
    VectorParams,
    PointStruct,
    Filter,
    FieldCondition,
    MatchValue
)

from ..domain.events import (
    event_publisher,
    VectorItemAddedEvent,
    VectorCollectionCreatedEvent,
    VectorCollectionClearedEvent,
    VectorMigrationStartedEvent,
    VectorMigrationCompletedEvent
)
from .config import QdrantConfig


class QdrantVectorStore:
    def __init__(self, config: Optional[QdrantConfig] = None):
        self.config = config or QdrantConfig.from_env()
        self._client: Optional[QdrantSdkClient] = None

    def connect(self) -> None:
        if self._client is None:
            self._client = QdrantSdkClient(
                host=self.config.host,
                port=self.config.port,
                api_key=self.config.api_key,
                https=self.config.use_https
            )

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    def create_collection(self, recreate: bool = False) -> bool:
        self.connect()
        exists = self._client.collection_exists(self.config.collection_name)

        if exists and not recreate:
            return False

        if recreate and exists:
            self._client.delete_collection(self.config.collection_name)

        self._client.create_collection(
            collection_name=self.config.collection_name,
            vectors_config=VectorParams(
                size=self.config.vector_size,
                distance=Distance[self.config.distance.upper()]
            )
        )

        event_publisher.publish(VectorCollectionCreatedEvent(
            payload={"collection_name": self.config.collection_name, "vector_size": self.config.vector_size}
        ))
        return True

    def add_vector(self, vector: List[float], payload: Dict[str, Any], point_id: Optional[UUID] = None) -> UUID:
        self.connect()
        point_id = point_id or uuid4()

        point = PointStruct(
            id=str(point_id),
            vector=vector,
            payload=payload
        )

        self._client.upsert(
            collection_name=self.config.collection_name,
            points=[point]
        )

        event_publisher.publish(VectorItemAddedEvent(
            payload={"point_id": str(point_id), "payload_keys": list(payload.keys())}
        ))
        return point_id

    def add_vectors_batch(self, items: List[tuple[List[float], Dict[str, Any]]]) -> List[UUID]:
        self.connect()
        points = []
        ids = []

        for vector, payload in items:
            point_id = uuid4()
            ids.append(point_id)
            points.append(PointStruct(
                id=str(point_id),
                vector=vector,
                payload=payload
            ))

        self._client.upsert(
            collection_name=self.config.collection_name,
            points=points
        )

        for pid in ids:
            event_publisher.publish(VectorItemAddedEvent(
                payload={"point_id": str(pid)}
            ))
        return ids

    def search(self, vector: List[float], limit: int = 10, quadrant: Optional[int] = None) -> List[Dict]:
        self.connect()
        query_filter = None

        if quadrant is not None:
            query_filter = Filter(
                must=[
                    FieldCondition(
                        key="quadrant",
                        match=MatchValue(value=quadrant)
                    )
                ]
            )

        results = self._client.search(
            collection_name=self.config.collection_name,
            query_vector=vector,
            limit=limit,
            query_filter=query_filter,
            with_payload=True
        )

        try:
            iter(results)
        except TypeError:
            return []

        return [
            {
                "id": res.id,
                "score": res.score,
                "payload": res.payload
            }
            for res in results
        ]

    def clear(self) -> None:
        self.connect()
        self._client.delete_collection(self.config.collection_name)
        self.create_collection()
        event_publisher.publish(VectorCollectionClearedEvent(
            payload={"collection_name": self.config.collection_name}
        ))

    def count(self) -> int:
        self.connect()
        return self._client.count(self.config.collection_name).count

    def migrate_from_local_store(self, local_store, embedding_function) -> Dict[str, Any]:
        event_publisher.publish(VectorMigrationStartedEvent())

        items = local_store.load()
        migrated_count = 0

        for item in items:
            vector = embedding_function(item["text"])
            self.add_vector(vector, item)
            migrated_count += 1

        event_publisher.publish(VectorMigrationCompletedEvent(
            payload={"migrated_items": migrated_count}
        ))

        return {
            "migrated_items": migrated_count,
            "collection_name": self.config.collection_name
        }
