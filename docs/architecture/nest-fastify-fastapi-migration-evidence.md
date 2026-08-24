# NestJS/Fastify + FastAPI migration evidence

Data świeżej weryfikacji i akceptacji właściciela: 2026-08-24. Bazowy oracle i artefakt rollbacku Express: `5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9`. Zweryfikowany lokalny kandydat przed tym dokumentem: `b3d53d0afdd85d8362189f72e8286c672cf971a9`.

Status: lokalny kod, kontrakty, testy, benchmark i rollback są zielone. Właściciel zdecydował pozostawić aktualną architekturę Nest/Fastify i kontynuować ukończenie celu, akceptując jawnie zmierzony koszt RSS/cold startu. TASK-066 może zostać lokalnie zakończony.

## Architektura i granice

- `backend-node` ma jeden bootstrap NestJS 11 na adapterze Fastify 5. Wszystkie 41 wierszy w mapie HTTP ma jednego właściciela `nest-final`; legacy route tree i Express-only bootstrap zostały usunięte.
- Bootstrap ładuje i waliduje konfigurację raz, publiczny i wewnętrzny Calendar używają jednej instancji `CalendarApplicationService`, a request ID, principal i timing są przechowywane w jednym kontekście dekorowanym przez Fastify. Usunięto wcześniejsze wielokrotne composition allocations bez tworzenia drugiego runtime'u lub ścieżki kompatybilności.
- Kontrolery są adapterami HTTP. `TaskCommandService`, `TaskQueryService`, `CalendarApplicationService`, `CalendarInternalService`, `GoogleOAuthService` i `GoogleCalendarService` pozostają właścicielami koordynacji semantycznej. Nie wprowadzono generycznego `BaseRepository`, event sourcingu ani ceremonialnego framework busa.
- FastAPI pozostaje właścicielem synchronicznego AI/RAG zgodnie z ADR 0001. n8n jest wyłącznie asynchronicznym konsumentem; Django i Flask nie zostały dodane.
- `backend-ai/app/main.py` jest 36-liniową fasadą kompatybilności. Import-safe `app/http/factory.py` składa skupione moduły composition, middleware, errors, schemas, health, analysis, knowledge, OCR, internal, training i operator; lightweight oraz knowledge-only role zachowują ograniczone powierzchnie.
- `node scripts/verify-framework-boundaries.mjs` oraz 7 testów evidence potwierdzają pojedynczy transport, 24 ścieżki OpenAPI FastAPI, stabilne entrypointy i brak wycieku typów framework/provider do wskazanych portów, jobs i payloadów.

## Zgodność i bezpieczeństwo

- Niezależny od transportu harness przechowuje niezmienny fixture Express z dokładnego SHA. Wszystkie 41 prób realnego HTTP Nest/Fastify odpowiada fixture pod względem metod, ścieżek, statusów, body, istotnych nagłówków i obserwowalnego stanu.
- Zachowane są ETag/If-Match, idempotency/replay, pagination cursors/headers, Bearer/OIDC scopes, trusted Origin/CORS, rate limit, request IDs, fail-closed audit chain, internal HMAC, OAuth state/redirect oraz Calendar outbox/webhook/reconciliation.
- CSRF: obecny kontrakt używa jawnego Bearer i `credentials: omit`, bez ambient session cookies, więc klasyczny credentialed CSRF nie ma zastosowania. Nie osłabiono jednak Origin ani CORS; unsafe browser requests z obcym Origin nadal fail-closed. Wprowadzenie cookies wymaga osobnego projektu CSRF.
- Fastify jest pojedynczym właścicielem security headers, CORS, parser/raw-body/body limit i proxy/rate limiting. Testy realnego adaptera obejmują `32kb`, dokładne 413, preflight, Origin, raw-byte HMAC oraz nagłówki limitów.
- Durable async nie został zastąpiony zdarzeniami in-process: Mongo nadal jest źródłem prawdy dla idempotency receipts, audit, OAuth, bindingów, outbox leases/retries/dead-letter, webhook replay i reconciliation. n8n zachowuje podpisane, replay-safe kontrakty.
- Podział command/query jest semantyczny tylko tam, gdzie pomaga odróżnić mutacje od odczytów. To nie jest pełny CQRS ani dowód pełnego DDD. Porty/adapters są stosowane pragmatycznie; typy Nest, Fastify, FastAPI, Pydantic i provider SDK nie definiują kontraktów core.
- Testy zachowania są dowodem bieżącego wyniku RED/GREEN i regresji, ale nie dowodzą historycznej metody TDD dla wcześniejszego kodu. BDD jest obecne jako 21 wykonywalnych scenariuszy Cucumber / 149 kroków.

## Świeża weryfikacja

Wszystkie poniższe polecenia zakończyły się kodem `0` w tym worktree:

- `make prepare-verify`: zależności przygotowane; npm backend-node zgłosił 0 podatności.
- `backend-node`: build i typecheck; 27 suite / 389 testów; 100% statements, branches, functions i lines dla mierzonej logiki application/domain/persistence/provider; 21 scenariuszy BDD / 149 kroków. Nowe testy kompozycji potwierdzają pojedynczy odczyt konfiguracji, jedną instancję Calendar i jeden kontekst requestu dekorowany przez Fastify.
- `backend-ai`: 893 passed, 13 skipped, 87.58% coverage; Pylint 10.00/10. Zamrożone pliki zatwierdzonego korpusu RAG są bajtowo identyczne z bazą, a 4 testy reprodukowalności review packet są zielone.
- API client: 34 testy i typecheck. MCP: 50 testów. n8n: 13 testów Python oraz 7 Node.
- web: build, 30 suite / 254 testy przy 100% coverage oraz 2 testy integracyjne. mobile: 21 suite / 202 testy; root coverage 95.55% statements / 90.16% branches / 95.65% functions / 96.58% lines.
- `make verify`: pełna bramka zakończona kodem `0`, łącznie z audytami produkcyjnymi, formatowaniem, buildami, testami, typecheck i lint.
- Evidence gate: `7 passed`; framework verifier, ancestor check, forbidden-import searches oraz `git diff --check` są zielone. TASK-065 pozostaje bajtowo identyczny z bazą (SHA-256 sekcji `61cc8258303c6827e185648698b9f8eb73c82fe83d8c044e4ac8bbb1c4db9bb9`).

Audyt zależności nie jest kompletnym dowodem braku podatności. Własny audyt Python sprawdził 201 zależności, ale pozostawił jawne blind spoty dla `en-core-web-sm==3.8.0`, `torch==2.13.0+cpu` i `torchvision==0.28.0+cpu`; `pip-audit` nie potrafił audytować wheel `torch` spoza PyPI. Osobny skan źródłowy/obrazu pozostaje odrębną bramką release.

## Benchmark, optymalizacja i zaakceptowana decyzja

Surowe dane są w `benchmarks/results/nest-fastify-migration.json`, a interpretacja w `docs/benchmarks/2026-08-23-express-vs-nest-fastify.md`. Metoda: ten sam host i Node `v24.18.0`, Express z exact baseline, Nest/Fastify candidate, warm-up 5 s, pomiar 15 s, 5 naprzemiennych powtórzeń, concurrency 1/10/50, pamięciowy Mongo i jednoelementowy Mongo replica set, po 10 cold startów. Cold start zapisuje oddzielnie czas do gotowości serwera, odpowiedzi liveness `/health` i odpowiedzi readiness `/health/ready`.

- Po usunięciu duplikatów kompozycji nie ma regresji >20% w throughput ani p95. Przy medianie delt sparowanych powtórzeń zakres throughput wynosi od `-2.40%` do `+8.28%`, a p95 od `-6.00%` do `+3.68%`. Poprzedni alert p95 był artefaktem dzielenia niezależnie agregowanych median z narastającej serii zapisów.
- RSS po długim obciążeniu nadal przekracza próg w części scenariuszy, ale diagnostyka dwukrotnego pełnego GC nie wskazuje wycieku: żywy heap Nest wynosi `30.93–33.42 MiB`, Express `23.20–26.13 MiB`, czyli różnica absolutna `7.29–7.83 MiB`. W świeżym procesie medianowy RSS Nest wynosi około `124 MiB`, o około `18–20 MiB` więcej niż Express; pozostała część wysokiego RSS to pojemność sterty zachowana przez V8 po skoku alokacji.
- W trybie memory Nest/Fastify jest wolniejszy przy cold starcie o `+67.45%` do server-ready, `+67.21%` do liveness i `+66.94%` do readiness. W trybie Mongo analogiczne regresje wynoszą `+50.51%`, `+50.11%` i `+49.95%`. W wartościach bezwzględnych Nest odpowiada na liveness po medianie `428.16 ms` (memory) i `376.32 ms` (Mongo).
- Krótki eksperyment z `--max-semi-space-size=4` obniżył high-water RSS, lecz pogorszył przepustowość liveness Nest względem Express; nie został przyjęty. Globalne raw body zachowano, ponieważ różnica żywego heap między task-create i liveness była podobna po obu stronach, a mechanizm jest częścią fail-closed kontraktu internal HMAC.
- Pozostały koszt pochodzi przede wszystkim z pełnego kontenera DI, skanowania metadata/dekoratorów i request lifecycle Nest. Usunięcie go wymagałoby rezygnacji z Nest na rzecz czystego Fastify albo osobnego, lżejszego procesu health; oba warianty zmieniają zaakceptowaną architekturę lub ponownie tworzą podwójne elementy.

To syntetyczny benchmark transportu, nie capacity test ani dowód produkcyjny. Po pracy optymalizacyjnej właściciel zaakceptował 2026-08-24 pozostawienie aktualnej architektury i jej jawnego kosztu. Status decyzji: **ACCEPTED FOR LOCAL COMPLETION**.

## Rollback

`node scripts/rehearse-node-transport-rollback.mjs` uruchomił sekwencję `Nest -> Express -> Nest` na tym samym izolowanym `MongoMemoryReplSet`, nigdy równolegle i bez polecenia migracji danych. Wszystkie trzy procesy zakończyły się kodem `0`.

- Nest zapisał task revision 1, durable idempotency receipt, Calendar binding i outbox lease.
- Exact Express baseline odczytał te same dane i receipt, odtworzył identyczny claim oraz zapisał task revision 2.
- Przywrócony Nest odczytał revision 2 i ten sam receipt/lease, po czym zakończył outbox jako `delivered`.

Dowód i procedura: `docs/evidence/2026-08-23-node-transport-rollback.md` oraz `docs/runbooks/node-transport-rollback.md`. Rehearsal nie wykonuje nieodwracalnej migracji Mongo i dowodzi wyłącznie lokalnej zgodności danych, nie wdrożonego rollbacku.

## Kryteria ukończenia i granica dowodu

Wszystkie lokalne kryteria source/contract/test/docs/benchmark/rollback są spełnione, a materialny koszt RSS/cold startu został osobiście zaakceptowany przez właściciela. TASK-066 zostaje przeniesiony do Done; ukończenie pozostaje ograniczone do lokalnego źródła i dowodów.

Nie wykonano push, PR, merge/promocji `dev` lub `master`, publikacji pakietu/obrazu/SBOM, deploymentu, aktywacji runtime, zmiany routingu ani danych użytkownika. Ten dokument nie twierdzi publicznego runtime, produkcji, realnego ruchu, fizycznej akceptacji ani human acceptance.
