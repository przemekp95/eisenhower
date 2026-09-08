# Rollback transportu Node

Ten runbook dotyczy wyłącznie cofnięcia warstwy HTTP `Nest -> Express -> Nest` bez migracji danych. Dokładnym źródłem rollbacku Express jest commit `5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9`; nie wolno zastępować go ruchomą gałęzią lokalną.

## Warunki

- Zachowaj bieżący artefakt Nest/Fastify oraz dokładny artefakt Express z powyższego SHA.
- Oba artefakty muszą używać tego samego `MONGODB_URI`, sekretów HMAC, trybu uwierzytelnienia i kontraktów klienta.
- Zatrzymaj aktualny proces przed uruchomieniem drugiego. Nie uruchamiaj obu transportów jako współbieżnych writerów.
- Nie uruchamiaj migracji, transformacji kolekcji, importu/eksportu ani destrukcyjnych poleceń Mongo.

## Próba lokalna

```bash
node scripts/rehearse-node-transport-rollback.mjs \
  --baseline-sha 5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9 \
  --output docs/evidence/2026-08-23-node-transport-rollback.md
```

Skrypt buduje Express z `git archive`, uruchamia pojedynczy izolowany replica set i kolejno:

1. zapisuje zadanie i potwierdza idempotency w Nest, tworzy binding oraz leasing outboxa;
2. zatrzymuje Nest, odczytuje te same dane i wykonuje bezpieczny zapis rewizji w Express;
3. zatrzymuje Express, ponownie odczytuje dane w Nest i kończy leasing jako `delivered`.

Każdy proces musi zakończyć się kodem `0`, a raport musi wykazać tę samą tożsamość zadania, trwały receipt idempotency, binding oraz lease. Skrypt sprząta procesy i lokalny replica set także po błędzie.

## Operacyjny rollback

Przed przełączeniem zachowaj SHA/artefakt obu wersji, wykonaj backup zgodny z polityką środowiska i zamknij dopływ zapisów. Zatrzymaj Nest, ustaw dokładny artefakt Express przy niezmienionym `MONGODB_URI`, uruchom jego standardowe health/contract smoke i dopiero wtedy przywróć ruch. Powrót do Nest przebiega symetrycznie. Ten lokalny dowód nie upoważnia do wdrożenia ani nie zastępuje procedur środowiska docelowego.
