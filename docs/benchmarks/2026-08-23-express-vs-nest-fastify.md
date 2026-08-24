# Express baseline vs NestJS/Fastify

Data: 2026-08-23T16:29:33.849Z

Baseline: `5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9`; candidate: `089b11f8e09aacf03926d9d0d592e8084d887d47`; Node: `v24.18.0`.

To jest syntetyczny benchmark transportu na jednej maszynie i nie jest dowodem produkcyjnym ani pomiarem realnego ruchu. Tryb `memory` używa izolowanego MongoMemoryServer, a `mongo` jednoelementowego MongoMemoryReplSet; oba kontrolują dane, lecz nie odtwarzają sieci, dysku i obciążenia produkcyjnego.

Metoda: warm-up 5s, pomiar 15s, 5 naprzemiennych powtórzeń, concurrency 1/10/50, 10 cold startów. Progi regresji load są liczone jako mediana delt sparowanych powtórzeń Express/Nest, co ogranicza błąd wynikający z narastania danych i kolejności pomiaru.

| Storage | Scenariusz | C | Implementacja | throughput req/s | p50 ms | p95 ms | p99 ms | RSS MiB |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| memory | liveness | 1 | express | 817.02 | 1.21 | 1.38 | 1.62 | 126.98 |
| memory | liveness | 1 | nest-fastify | 827.39 | 1.20 | 1.35 | 1.60 | 318.98 |
| memory | liveness | 10 | express | 6923.52 | 1.48 | 2.05 | 3.49 | 132.57 |
| memory | liveness | 10 | nest-fastify | 6932.40 | 1.48 | 2.04 | 3.53 | 338.10 |
| memory | liveness | 50 | express | 20959.73 | 1.96 | 5.14 | 7.13 | 219.75 |
| memory | liveness | 50 | nest-fastify | 21485.39 | 1.94 | 5.11 | 6.83 | 365.27 |
| memory | task-list | 1 | express | 642.86 | 1.53 | 1.88 | 2.33 | 139.84 |
| memory | task-list | 1 | nest-fastify | 647.89 | 1.52 | 1.85 | 2.26 | 298.04 |
| memory | task-list | 10 | express | 4307.82 | 2.41 | 3.54 | 5.18 | 301.96 |
| memory | task-list | 10 | nest-fastify | 4384.37 | 2.37 | 3.53 | 5.44 | 349.86 |
| memory | task-list | 50 | express | 7547.18 | 6.11 | 11.09 | 14.11 | 338.02 |
| memory | task-list | 50 | nest-fastify | 7903.40 | 5.82 | 10.45 | 13.36 | 366.37 |
| memory | task-create | 1 | express | 46.15 | 21.44 | 25.52 | 36.36 | 152.59 |
| memory | task-create | 1 | nest-fastify | 45.79 | 20.84 | 31.16 | 37.91 | 237.26 |
| memory | task-create | 10 | express | 166.63 | 59.98 | 67.68 | 77.43 | 232.99 |
| memory | task-create | 10 | nest-fastify | 163.21 | 61.14 | 71.34 | 79.03 | 298.16 |
| memory | task-create | 50 | express | 336.39 | 147.08 | 206.69 | 222.70 | 268.72 |
| memory | task-create | 50 | nest-fastify | 333.08 | 146.69 | 210.02 | 228.67 | 344.14 |
| mongo | liveness | 1 | express | 809.34 | 1.22 | 1.39 | 1.64 | 125.30 |
| mongo | liveness | 1 | nest-fastify | 810.45 | 1.22 | 1.42 | 1.67 | 258.15 |
| mongo | liveness | 10 | express | 6559.29 | 1.54 | 2.08 | 6.37 | 157.64 |
| mongo | liveness | 10 | nest-fastify | 6523.66 | 1.53 | 2.12 | 6.23 | 322.21 |
| mongo | liveness | 50 | express | 17632.05 | 2.25 | 8.11 | 10.23 | 217.21 |
| mongo | liveness | 50 | nest-fastify | 17748.86 | 2.23 | 7.93 | 10.14 | 350.30 |
| mongo | task-list | 1 | express | 627.37 | 1.57 | 1.92 | 2.37 | 142.84 |
| mongo | task-list | 1 | nest-fastify | 627.01 | 1.57 | 1.91 | 2.45 | 334.02 |
| mongo | task-list | 10 | express | 4121.68 | 2.48 | 3.76 | 7.34 | 304.43 |
| mongo | task-list | 10 | nest-fastify | 4124.82 | 2.48 | 3.82 | 7.52 | 365.41 |
| mongo | task-list | 50 | express | 6994.63 | 6.59 | 12.46 | 15.38 | 320.07 |
| mongo | task-list | 50 | nest-fastify | 7357.80 | 6.05 | 11.77 | 14.89 | 385.01 |
| mongo | task-create | 1 | express | 44.45 | 21.89 | 28.55 | 32.75 | 143.49 |
| mongo | task-create | 1 | nest-fastify | 44.57 | 22.01 | 26.64 | 33.63 | 235.25 |
| mongo | task-create | 10 | express | 156.44 | 63.96 | 72.09 | 82.52 | 228.14 |
| mongo | task-create | 10 | nest-fastify | 156.81 | 63.41 | 73.48 | 83.57 | 302.65 |
| mongo | task-create | 50 | express | 351.35 | 129.46 | 208.48 | 223.56 | 253.10 |
| mongo | task-create | 50 | nest-fastify | 336.35 | 132.64 | 220.14 | 238.85 | 364.89 |

## Pamięć po obciążeniu i wymuszonym GC

RSS jest high-water mark procesu i może pozostać wysokie po zwolnieniu obiektów. Dlatego obok RSS raport pokazuje żywy heap po dwukrotnym pełnym GC; wymuszony GC służy wyłącznie diagnostyce i nie jest rekomendacją dla runtime.

| Storage | Scenariusz | Implementacja | heap przed GC MiB | heap po GC MiB | RSS po GC MiB |
| --- | --- | --- | ---: | ---: | ---: |
| memory | liveness | express | 49.80 | 23.20 | 214.78 |
| memory | liveness | nest-fastify | 101.93 | 30.93 | 361.03 |
| memory | task-list | express | 90.91 | 24.52 | 334.35 |
| memory | task-list | nest-fastify | 144.68 | 32.33 | 363.33 |
| memory | task-create | express | 39.61 | 25.93 | 262.60 |
| memory | task-create | nest-fastify | 151.77 | 33.22 | 344.11 |
| mongo | liveness | express | 58.79 | 23.36 | 222.55 |
| mongo | liveness | nest-fastify | 40.26 | 31.09 | 346.09 |
| mongo | task-list | express | 69.85 | 24.75 | 326.65 |
| mongo | task-list | nest-fastify | 149.27 | 32.59 | 381.27 |
| mongo | task-create | express | 28.57 | 26.13 | 248.41 |
| mongo | task-create | nest-fastify | 156.93 | 33.42 | 360.10 |

## Cold start

| Storage | Implementacja | server ready median ms | liveness median ms | readiness median ms | RSS median MiB |
| --- | --- | ---: | ---: | ---: | ---: |
| memory | express | 249.91 | 256.06 | 257.19 | 104.35 |
| memory | nest-fastify | 418.48 | 428.16 | 429.36 | 124.03 |
| mongo | express | 244.98 | 250.69 | 251.72 | 106.27 |
| mongo | nest-fastify | 368.71 | 376.32 | 377.44 | 124.44 |

## Regresje powyżej 20%

- memory/liveness/c1: throughput 0.46%, p95 -2.23%, RSS 151.19%
- memory/liveness/c10: throughput 0.05%, p95 0.05%, RSS 155.04%
- memory/liveness/c50: throughput 1.80%, p95 -1.48%, RSS 66.23%
- memory/task-list/c1: throughput 0.83%, p95 -2.45%, RSS 113.14%
- memory/task-create/c1: throughput -0.77%, p95 3.01%, RSS 55.49%
- memory/task-create/c10: throughput -0.26%, p95 3.68%, RSS 30.44%
- memory/task-create/c50: throughput 0.77%, p95 0.66%, RSS 29.28%
- mongo/liveness/c1: throughput 0.52%, p95 1.66%, RSS 105.87%
- mongo/liveness/c10: throughput -0.80%, p95 2.73%, RSS 104.40%
- mongo/liveness/c50: throughput 0.93%, p95 -1.15%, RSS 60.61%
- mongo/task-list/c1: throughput -0.08%, p95 -1.80%, RSS 133.44%
- mongo/task-list/c10: throughput 0.37%, p95 0.83%, RSS 20.03%
- mongo/task-create/c1: throughput 0.40%, p95 0.98%, RSS 63.82%
- mongo/task-create/c10: throughput -0.10%, p95 1.92%, RSS 32.66%
- mongo/task-create/c50: throughput -2.40%, p95 2.43%, RSS 44.16%
- memory/cold-start/server-ready: czas uruchomienia 67.45%
- memory/cold-start/liveness: czas uruchomienia 67.21%
- memory/cold-start/readiness: czas uruchomienia 66.94%
- mongo/cold-start/server-ready: czas uruchomienia 50.51%
- mongo/cold-start/liveness: czas uruchomienia 50.11%
- mongo/cold-start/readiness: czas uruchomienia 49.95%

Wynik wskazuje koszt pełnego kontenera DI/dekoratorów Nest przy zachowaniu kontraktu. Diagnostyka heap/RSS pozwala odróżnić żywe obiekty od pamięci zachowanej przez V8 po skoku alokacji. Każda wymieniona regresja jest jawna; syntetyczny pomiar nie uzasadnia sam w sobie optymalizacji kosztem bezpieczeństwa lub zgodności.
