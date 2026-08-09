#!/usr/bin/env python3
"""Migrate an existing local training index to Qdrant.

Usage: python3 -m app.migrate_to_qdrant
"""
from __future__ import annotations
from pathlib import Path
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.store import TrainingStore
from app.vector import QdrantVectorStore
from app.store_qdrant_adapter import QdrantTrainingStoreAdapter


def main():
    print("Starting migration to Qdrant Vector Database")
    print("=" * 60)

    data_path = Path(os.getenv("TRAINING_DATA_PATH", "data/training.json"))
    print(f"Local data file: {data_path}")

    vector_store = QdrantVectorStore()
    print(f"Qdrant configuration: {vector_store.config.to_dict()}")

    print("\nCreating the collection if it does not exist...")
    created = vector_store.create_collection()
    if created:
        print("Created a new Qdrant collection")
    else:
        print("The Qdrant collection already exists")

    adapter = QdrantTrainingStoreAdapter(data_path, vector_store)
    print("\nRunning migration...")

    result = adapter.migrate_existing_index()

    print("\nMigration completed successfully")
    print(f"   Migrated items: {result['migrated_items']}")
    print(f"   Qdrant collection: {result['collection_name']}")

    stats = adapter.get_stats()
    print("\nFinal status:")
    print(f"   Total examples: {stats['total_examples']}")
    print(f"   Vectors in index: {stats['vector_index_count']}")

    print("\nDone")


if __name__ == "__main__":
    main()
