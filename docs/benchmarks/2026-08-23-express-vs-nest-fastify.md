# Express baseline vs NestJS/Fastify

Data: 2026-08-23T14:56:02.152Z

Baseline: `5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9`; candidate: `5d74809cd334ebc4b7c7fba20dea42713f825260`; Node: `v24.18.0`.

To jest syntetyczny benchmark transportu na jednej maszynie i nie jest dowodem produkcyjnym ani pomiarem realnego ruchu. Tryb `memory` używa izolowanego MongoMemoryServer, a `mongo` jednoelementowego MongoMemoryReplSet; oba kontrolują dane, lecz nie odtwarzają sieci, dysku i obciążenia produkcyjnego.

Metoda: warm-up 5s, pomiar 15s, 5 naprzemiennych powtórzeń, concurrency 1/10/50, 10 cold startów.

| Storage | Scenariusz | C | Implementacja | throughput req/s | p50 ms | p95 ms | p99 ms | RSS MiB |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| memory | liveness | 1 | express | 828.56 | 1.19 | 1.35 | 1.55 | 125.43 |
| memory | liveness | 1 | nest-fastify | 833.48 | 1.18 | 1.37 | 1.59 | 317.64 |
| memory | liveness | 10 | express | 6743.37 | 1.46 | 2.08 | 6.32 | 129.07 |
| memory | liveness | 10 | nest-fastify | 6806.41 | 1.46 | 2.03 | 6.35 | 322.18 |
| memory | liveness | 50 | express | 19613.54 | 1.90 | 7.72 | 10.74 | 217.82 |
| memory | liveness | 50 | nest-fastify | 19701.94 | 1.90 | 7.79 | 10.40 | 351.21 |
| memory | task-list | 1 | express | 646.44 | 1.52 | 1.88 | 2.21 | 141.83 |
| memory | task-list | 1 | nest-fastify | 642.89 | 1.51 | 1.94 | 2.39 | 290.47 |
| memory | task-list | 10 | express | 4287.12 | 2.35 | 3.64 | 7.25 | 300.37 |
| memory | task-list | 10 | nest-fastify | 4285.62 | 2.36 | 3.76 | 7.70 | 351.23 |
| memory | task-list | 50 | express | 7787.04 | 5.64 | 12.00 | 15.14 | 315.83 |
| memory | task-list | 50 | nest-fastify | 7693.84 | 5.77 | 11.75 | 14.66 | 367.27 |
| memory | task-create | 1 | express | 47.43 | 20.80 | 26.60 | 37.50 | 140.73 |
| memory | task-create | 1 | nest-fastify | 45.43 | 21.07 | 30.90 | 38.56 | 200.48 |
| memory | task-create | 10 | express | 164.19 | 60.82 | 69.29 | 77.96 | 211.64 |
| memory | task-create | 10 | nest-fastify | 165.44 | 60.29 | 67.94 | 77.33 | 331.79 |
| memory | task-create | 50 | express | 333.25 | 147.01 | 210.20 | 226.93 | 295.88 |
| memory | task-create | 50 | nest-fastify | 346.99 | 136.56 | 204.13 | 225.72 | 378.88 |
| mongo | liveness | 1 | express | 799.53 | 1.22 | 1.48 | 1.72 | 126.40 |
| mongo | liveness | 1 | nest-fastify | 806.97 | 1.22 | 1.45 | 1.74 | 315.73 |
| mongo | liveness | 10 | express | 6396.78 | 1.55 | 2.19 | 6.34 | 133.02 |
| mongo | liveness | 10 | nest-fastify | 6396.64 | 1.54 | 2.26 | 6.52 | 348.76 |
| mongo | liveness | 50 | express | 16764.25 | 2.32 | 8.59 | 11.49 | 215.70 |
| mongo | liveness | 50 | nest-fastify | 15932.21 | 2.37 | 8.59 | 11.96 | 377.36 |
| mongo | task-list | 1 | express | 616.55 | 1.58 | 1.99 | 2.39 | 138.63 |
| mongo | task-list | 1 | nest-fastify | 626.34 | 1.56 | 1.94 | 2.52 | 258.96 |
| mongo | task-list | 10 | express | 4043.14 | 2.51 | 3.94 | 7.92 | 303.18 |
| mongo | task-list | 10 | nest-fastify | 4118.76 | 2.45 | 3.82 | 8.04 | 345.83 |
| mongo | task-list | 50 | express | 6941.78 | 6.32 | 13.25 | 16.75 | 321.08 |
| mongo | task-list | 50 | nest-fastify | 7282.17 | 6.01 | 12.61 | 15.53 | 368.37 |
| mongo | task-create | 1 | express | 44.16 | 22.13 | 29.01 | 35.87 | 141.63 |
| mongo | task-create | 1 | nest-fastify | 43.72 | 22.01 | 32.51 | 37.90 | 239.96 |
| mongo | task-create | 10 | express | 156.08 | 63.97 | 69.48 | 80.11 | 245.27 |
| mongo | task-create | 10 | nest-fastify | 157.58 | 63.20 | 71.14 | 82.92 | 324.81 |
| mongo | task-create | 50 | express | 332.27 | 133.09 | 217.02 | 228.08 | 304.96 |
| mongo | task-create | 50 | nest-fastify | 334.53 | 128.60 | 224.74 | 243.83 | 360.74 |

## Cold start

| Storage | Implementacja | median ms |
| --- | --- | ---: |
| memory | express | 234.09 |
| memory | nest-fastify | 374.32 |
| mongo | express | 242.80 |
| mongo | nest-fastify | 375.15 |

## Regresje powyżej 20%

- memory/liveness/c1: throughput 0.59%, p95 1.18%, RSS 153.23%
- memory/liveness/c10: throughput 0.93%, p95 -2.35%, RSS 149.62%
- memory/liveness/c50: throughput 0.45%, p95 0.95%, RSS 61.24%
- memory/task-list/c1: throughput -0.55%, p95 3.03%, RSS 104.80%
- memory/task-create/c1: throughput -4.22%, p95 16.16%, RSS 42.45%
- memory/task-create/c10: throughput 0.76%, p95 -1.95%, RSS 56.77%
- memory/task-create/c50: throughput 4.12%, p95 -2.89%, RSS 28.05%
- mongo/liveness/c1: throughput 0.93%, p95 -2.16%, RSS 149.78%
- mongo/liveness/c10: throughput -0.00%, p95 2.85%, RSS 162.19%
- mongo/liveness/c50: throughput -4.96%, p95 0.00%, RSS 74.94%
- mongo/task-list/c1: throughput 1.59%, p95 -2.48%, RSS 86.80%
- mongo/task-create/c1: throughput -0.98%, p95 12.07%, RSS 69.43%
- mongo/task-create/c10: throughput 0.96%, p95 2.39%, RSS 32.43%
- memory/cold-start: czas uruchomienia 59.90%
- mongo/cold-start: czas uruchomienia 54.51%

Wynik wskazuje koszt pełnego kontenera DI/dekoratorów Nest przy zachowaniu kontraktu. Każda wymieniona regresja jest jawna; syntetyczny pomiar nie uzasadnia sam w sobie optymalizacji kosztem bezpieczeństwa lub zgodności.
