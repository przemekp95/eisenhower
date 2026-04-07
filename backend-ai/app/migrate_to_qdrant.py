#!/usr/bin/env python3
"""
Skrypt migracji istniejącego lokalnego indeksu do Qdrant
Użycie: python3 -m app.migrate_to_qdrant
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
    print("🔄 Rozpoczynam migrację do Qdrant Vector Database")
    print("=" * 60)

    data_path = Path(os.getenv("TRAINING_DATA_PATH", "data/training.json"))
    print(f"✅ Lokalny plik danych: {data_path}")

    vector_store = QdrantVectorStore()
    print(f"✅ Konfiguracja Qdrant: {vector_store.config.to_dict()}")

    print("\n⚙️  Tworzenie kolekcji (jeśli nie istnieje)...")
    created = vector_store.create_collection()
    if created:
        print("✅ Utworzono nową kolekcję w Qdrant")
    else:
        print("ℹ️  Kolekcja już istnieje")

    adapter = QdrantTrainingStoreAdapter(data_path, vector_store)
    print("\n🚀 Uruchamiam migrację...")

    result = adapter.migrate_existing_index()

    print("\n✅ Migracja zakończona pomyślnie!")
    print(f"   Przeniesionych elementów: {result['migrated_items']}")
    print(f"   Kolekcja w Qdrant: {result['collection_name']}")

    stats = adapter.get_stats()
    print(f"\n📊 Status końcowy:")
    print(f"   Całkowita liczba przykładów: {stats['total_examples']}")
    print(f"   Liczba wektorów w indeksie: {stats['vector_index_count']}")

    print("\n🎉 Gotowe!")


if __name__ == "__main__":
    main()
