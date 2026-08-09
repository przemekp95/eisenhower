from __future__ import annotations
import logging
from typing import Callable

from app.domain.events import DomainEvent, VectorEventType


logger = logging.getLogger(__name__)


def log_vector_events(event: DomainEvent) -> None:
    """Log vector-index events for the experimental integration."""
    match event.event_type:
        case VectorEventType.ITEM_ADDED:
            logger.info(f"Vector added, point={event.payload.get('point_id')}")
        case VectorEventType.COLLECTION_CREATED:
            logger.info(f"Vector collection created: {event.payload.get('collection_name')}")
        case VectorEventType.MIGRATION_COMPLETED:
            logger.info(f"Vector migration completed: {event.payload.get('migrated_items')} items")
        case _:
            logger.debug(f"Vector event: {event.event_type.value}")


def register_default_handlers() -> None:
    """Register the default vector-event handlers."""
    from app.domain.events import event_publisher
    event_publisher.subscribe(log_vector_events)


def on_vector_item_added(callback: Callable[[DomainEvent], None]) -> None:
    """Subscribe a callback to vector item-added events."""
    from app.domain.events import event_publisher

    def wrapper(event: DomainEvent):
        if event.event_type == VectorEventType.ITEM_ADDED:
            callback(event)

    event_publisher.subscribe(wrapper)
