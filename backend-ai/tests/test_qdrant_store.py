from unittest.mock import Mock, patch, MagicMock
from uuid import UUID
import pytest

from app.vector import QdrantConfig, QdrantVectorStore
from app.domain.events import event_publisher, DomainEvent, VectorEventType


@pytest.fixture
def test_config():
    return QdrantConfig(
        host="test-host",
        port=1234,
        api_key="test-key",
        collection_name="test-collection",
        vector_size=384
    )


@pytest.fixture
def qdrant_store(test_config):
    with patch("app.vector.qdrant_client.QdrantSdkClient") as mock_client:
        store = QdrantVectorStore(test_config)
        store._client = Mock()
        yield store, mock_client, test_config


def test_qdrant_config_from_env():
    with patch.dict("os.environ", {
        "QDRANT_HOST": "custom-host",
        "QDRANT_PORT": "9999",
        "QDRANT_COLLECTION": "custom-collection"
    }):
        config = QdrantConfig.from_env()
        assert config.host == "custom-host"
        assert config.port == 9999
        assert config.collection_name == "custom-collection"


def test_create_collection_when_not_exists(qdrant_store):
    store, mock_client, config = qdrant_store
    store._client.collection_exists.return_value = False

    result = store.create_collection()

    assert result is True
    store._client.create_collection.assert_called_once()


def test_add_vector_generates_event(qdrant_store):
    store, mock_client, config = qdrant_store
    events = []

    def capture_event(event: DomainEvent):
        events.append(event)

    event_publisher.subscribe(capture_event)

    test_vector = [0.1] * 384
    test_payload = {"text": "test task", "quadrant": 2}

    point_id = store.add_vector(test_vector, test_payload)

    assert isinstance(point_id, UUID)
    assert len(events) == 1
    assert events[0].event_type == VectorEventType.ITEM_ADDED
    assert events[0].payload["point_id"] == str(point_id)


def test_migration_publishes_events(qdrant_store):
    store, mock_client, config = qdrant_store
    events = []

    def capture_event(event: DomainEvent):
        events.append(event)

    event_publisher.subscribe(capture_event)

    mock_local_store = Mock()
    mock_local_store.load.return_value = [
        {"text": "test 1", "quadrant": 1},
        {"text": "test 2", "quadrant": 2}
    ]

    mock_embedding = Mock(return_value=[0.1] * 384)

    result = store.migrate_from_local_store(mock_local_store, mock_embedding)

    assert result["migrated_items"] == 2
    assert len(events) == 4  # start + 2 added + completed
    assert events[0].event_type == VectorEventType.MIGRATION_STARTED
    assert events[-1].event_type == VectorEventType.MIGRATION_COMPLETED


def test_search_with_quadrant_filter(qdrant_store):
    store, mock_client, config = qdrant_store

    test_vector = [0.1] * 384
    store.search(test_vector, limit=5, quadrant=2)

    call_args = store._client.search.call_args
    assert call_args[1]["query_filter"] is not None
    assert call_args[1]["limit"] == 5
