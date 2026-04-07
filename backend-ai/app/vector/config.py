from __future__ import annotations
from dataclasses import dataclass
from os import getenv
from typing import Optional


@dataclass(frozen=True)
class QdrantConfig:
    host: str
    port: int
    api_key: Optional[str]
    collection_name: str
    vector_size: int
    distance: str = "Cosine"
    use_https: bool = False

    @classmethod
    def from_env(cls) -> "QdrantConfig":
        return cls(
            host=getenv("QDRANT_HOST", "localhost"),
            port=int(getenv("QDRANT_PORT", "6334")),
            api_key=getenv("QDRANT_API_KEY"),
            collection_name=getenv("QDRANT_COLLECTION", "eisenhower_task_embeddings"),
            vector_size=int(getenv("QDRANT_VECTOR_SIZE", "384")),
            distance=getenv("QDRANT_DISTANCE", "Cosine"),
            use_https=getenv("QDRANT_USE_HTTPS", "false").lower() == "true"
        )

    def to_dict(self) -> dict:
        return {
            "host": self.host,
            "port": self.port,
            "collection_name": self.collection_name,
            "vector_size": self.vector_size,
            "distance": self.distance,
            "use_https": self.use_https
        }
