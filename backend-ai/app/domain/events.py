from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional
from uuid import UUID, uuid4


def utc_now() -> datetime:
    return datetime.now(tz=timezone.utc)


class VectorEventType(Enum):
    ITEM_ADDED = "vector.item.added"
    ITEM_REMOVED = "vector.item.removed"
    COLLECTION_CREATED = "vector.collection.created"
    COLLECTION_CLEARED = "vector.collection.cleared"
    MIGRATION_STARTED = "vector.migration.started"
    MIGRATION_COMPLETED = "vector.migration.completed"


@dataclass(frozen=True)
class DomainEvent:
    event_id: UUID = field(default_factory=uuid4)
    timestamp: datetime = field(default_factory=utc_now)
    event_type: VectorEventType = None
    payload: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "event_id": str(self.event_id),
            "timestamp": self.timestamp.isoformat(),
            "event_type": self.event_type.value,
            "payload": self.payload
        }


@dataclass(frozen=True)
class VectorItemAddedEvent(DomainEvent):
    event_type: VectorEventType = VectorEventType.ITEM_ADDED


@dataclass(frozen=True)
class VectorItemRemovedEvent(DomainEvent):
    event_type: VectorEventType = VectorEventType.ITEM_REMOVED


@dataclass(frozen=True)
class VectorCollectionCreatedEvent(DomainEvent):
    event_type: VectorEventType = VectorEventType.COLLECTION_CREATED


@dataclass(frozen=True)
class VectorCollectionClearedEvent(DomainEvent):
    event_type: VectorEventType = VectorEventType.COLLECTION_CLEARED


@dataclass(frozen=True)
class VectorMigrationStartedEvent(DomainEvent):
    event_type: VectorEventType = VectorEventType.MIGRATION_STARTED


@dataclass(frozen=True)
class VectorMigrationCompletedEvent(DomainEvent):
    event_type: VectorEventType = VectorEventType.MIGRATION_COMPLETED


class EventPublisher:
    def __init__(self):
        self._subscribers = []

    def subscribe(self, subscriber):
        self._subscribers.append(subscriber)

    def publish(self, event: DomainEvent):
        for subscriber in self._subscribers:
            try:
                subscriber(event)
            except Exception:
                pass


event_publisher = EventPublisher()
