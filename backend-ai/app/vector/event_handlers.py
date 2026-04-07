from __future__ import annotations
import logging
from typing import Callable

from app.domain.events import DomainEvent, VectorEventType


logger = logging.getLogger(__name__)


def log_vector_events(event: DomainEvent) -> None:
    """Domyślny handler logujący wszystkie zdarzenia indeksu wektorowego"""
    match event.event_type:
        case VectorEventType.ITEM_ADDED:
            logger.info(f"✅ Dodano wektor punkt={event.payload.get('point_id')}")
        case VectorEventType.COLLECTION_CREATED:
            logger.info(f"🗂️  Utworzono kolekcję: {event.payload.get('collection_name')}")
        case VectorEventType.MIGRATION_COMPLETED:
            logger.info(f"✅ Migracja zakończona: {event.payload.get('migrated_items')} elementów")
        case _:
            logger.debug(f"Zdarzenie wektorowe: {event.event_type.value}")


def register_default_handlers() -> None:
    """Rejestruje domyślne handlery zdarzeń"""
    from app.domain.events import event_publisher
    event_publisher.subscribe(log_vector_events)


def on_vector_item_added(callback: Callable[[DomainEvent], None]) -> None:
    """Dekorator lub metoda do subskrypcji na dodawanie elementów"""
    from app.domain.events import event_publisher

    def wrapper(event: DomainEvent):
        if event.event_type == VectorEventType.ITEM_ADDED:
            callback(event)

    event_publisher.subscribe(wrapper)
