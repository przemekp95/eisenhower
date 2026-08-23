# HTTP migration benchmark

Runner builds the exact Express oracle from a temporary `git archive`, starts it and the current NestJS/Fastify build against isolated ephemeral Mongo instances, alternates measurement order, and records per-repetition latency/throughput/RSS plus cold-start samples. Fixtures run with `--expose-gc`: after each scenario the runner records heap/RSS before and after two forced full collections. This is diagnostic evidence only; production runtime does not force GC.

```bash
node benchmarks/http-migration/runner.mjs \
  --baseline-sha 5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9 \
  --warmup-seconds 5 --measurement-seconds 15 --repetitions 5 \
  --cold-starts 10 --concurrency 1,10,50 --storage memory,mongo
```

The benchmark is synthetic and deliberately does not claim production behavior. `memory` is an isolated standalone MongoMemoryServer; `mongo` is an isolated one-node MongoMemoryReplSet with transaction support.

Cold start records process-to-server-ready, liveness response and readiness response separately. To refresh only the 40 cold-start samples without repeating the load matrix:

```bash
node benchmarks/http-migration/runner.mjs \
  --baseline-sha 5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9 \
  --cold-start-only true --cold-starts 10
```
