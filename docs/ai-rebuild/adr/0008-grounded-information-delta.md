# ADR 0008: Przyrost informacji wymusza walidator aplikacyjny, nie sam prompt

- Status: Accepted locally; live-model rollout gated
- Data decyzji: 2026-08-11
- Zakres: online RAG, historia jawnie przekazana przez klienta, aktualność źródeł

## Kontekst

Dotychczasowy kontrakt klasyfikacji wymuszał poprawny schemat i cytowania z
wyrenderowanego kontekstu, ale nie porównywał tez z informacjami, które klient
już znał ani z poprzednimi odpowiedziami. Deduplicacja chunków usuwała tylko
identyczny znormalizowany tekst w bieżącym kontekście. Nie była kontrolą
semantycznych parafraz ani historią odpowiedzi. MAG pozostaje osobną domeną z
jawną zgodą i nie może być użyty jako ukryte źródło known-state.

## Decyzja

Klient może przekazać ograniczone listy `known_state` i
`previous_output_statements`. Każda pozycja ma stabilny identyfikator, język,
tekst oraz checksum znormalizowanej treści. Dane są oznaczone jako niezaufane,
nie trafiają do system promptu, nie rozszerzają listy dozwolonych źródeł i nie
powodują automatycznego zapisu pamięci.

Model zwraca strukturalny `information_delta` z jednym ze statusów:

- `new_information` lub `mixed` dla ugruntowanego przyrostu;
- `confirmation_only` dla potwierdzenia albo koniecznego przypomnienia;
- `no_new_information` dla uczciwego braku delty;
- `freshness_unverified`, gdy pytanie wymaga aktualnego świata, którego
  zamrożony snapshot nie dowodzi.

Każda teza ma relację `new_information`, `confirmation`, `contradiction`,
`update` albo `necessary_reminder`. Nowa informacja zawsze wymaga cytowania
chunka z wyrenderowanego kontekstu. Potwierdzenie, sprzeczność i aktualizacja
wymagają jawnego identyfikatora porównywanego twierdzenia oraz cytowania.
Konieczne przypomnienie wymaga identyfikatora znanej tezy i ograniczonego kodu
powodu; samo przypomnienie nie jest nagradzane jako nowość.

Prompt opisuje zadanie, ale nie jest granicą egzekwującą. Po odpowiedzi modelu
`InformationDeltaValidator` sprawdza w warstwie aplikacyjnej:

- spójność statusu, relacji, referencji i cytowań;
- semantyczne duplikaty wewnątrz odpowiedzi;
- podobieństwo nowych tez do całego jawnego known-state i poprzednich wyjść;
- semantyczny związek potwierdzeń, sprzeczności i aktualizacji z referencją;
- semantyczne wsparcie tezy przez wskazany chunk;
- brak cytowań i tez przy wymaganiu aktualności bieżącego świata.

Produkcja wiąże port podobieństwa z tym samym przypiętym wielojęzycznym
enkoderem MiniLM co retrieval. Polityka ma jawne progi i fail-closed gray zone;
testy kontraktowe używają deterministycznego fake'a, aby nie udawać jakości
konkretnego modelu. Niepoprawna delta uruchamia istniejący fallback z kodem
`invalid_information_delta`. Dla żądań delty API zwraca ustalone komunikaty
aplikacyjne, a nie swobodną narrację modelu.

## Świeżość świata

`content_version`, data indeksu i cytowanie dowodzą jedynie stanu konkretnego
snapshotu. Nie dowodzą, że świat nie zmienił się po jego utworzeniu. Żądanie
`current_world_required` kończy się deterministycznym
`freshness_unverified`, bez generowania i bez cytowań. Osobny, przyszły
mechanizm aktualnych źródeł musiałby mieć własną allowlistę, provenance,
timestamp, politykę błędów i testy; nie może być zasymulowany promptem.

## Bezpieczeństwo i prywatność

- Limity liczby i długości pozycji oraz checksumy zamykają niejawne rozszerzanie
  historii; przekroczenie budżetu kończy się błędem zamiast obcięcia stanu.
- Identyfikator wykonania wiąże tekst, checksumy, cytowane chunki, wersje
  contentu i wymaganie świeżości.
- Prompt injection w known-state pozostaje danymi użytkownika. Nie może dodać
  cytowania ani zmienić schematu.
- Brak automatycznego zapisu odpowiedzi. Retencja, eksport, usunięcie i zgoda
  pozostają wyłącznie w osobnej domenie MAG i jej bramkach.
- Jest to rozszerzenie istniejącego JSON API chronionego bearer auth. Nie dodaje
  cookie ani nowego mechanizmu przeglądarkowego; obowiązują istniejące kontrole
  Origin/CORS. Nie zmienia n8n, kolejek, jobs ani webhooków.

## Ewaluacja

Raport PL/EN rozdziela dokładność statusu, precision/recall/F1 nowej informacji,
sprzeczności/aktualizacji i koniecznych przypomnień, repetition escape,
fałszywy brak nowości, pokrycie ugruntowaniem i cytowaniem, nieugruntowane tezy,
powodzenie prompt injection, nadmierne twierdzenia o aktualności, abstencję w
gray zone, latency oraz koszt tokenów.

## Stan dowodów

- Kod źródłowy: kontrakt wejścia/wyjścia, walidator, adapter podobieństwa,
  endpoint i metryki są osiągalne w lokalnym grafie aplikacji.
- Testy: obejmują PL/EN, parafrazy, powtórzenia, potwierdzenia, sprzeczności,
  aktualizacje, konieczne przypomnienie, brak nowości, prompt injection,
  budżet i mockowany transport HTTP vLLM.
- Lokalny runtime: można wykonać walidację in-process oraz kontrakt adaptera na
  mockowanym HTTP. Nie jest to uruchomienie docelowego modelu.
- Live vLLM: niezweryfikowane; nadal blokowane przez TASK-013–TASK-015, wybór
  modelu/tokenizera, GPU, realny structured output i canary.
- Wdrożenie i dowód publiczny: nie istnieją i ta decyzja ich nie deklaruje.

Architektura jest pragmatycznie warstwowa z portem podobieństwa i adapterami;
nie jest dowodem pełnego DDD, CQRS ani BDD. Obecne testy są dowodem regresji,
ale repo nie zachowuje red-green history potrzebnej do uczciwego twierdzenia o
TDD dla tej zmiany.
