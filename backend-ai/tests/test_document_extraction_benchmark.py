from scripts.benchmark_document_extraction import summarize_runs


def test_benchmark_summary_separates_cold_warm_and_uses_per_process_rss():
  runs = [
    {"mode": "cold", "elapsed_seconds": 4.0, "process_peak_rss_bytes": 400},
    {"mode": "cold", "elapsed_seconds": 2.0, "process_peak_rss_bytes": 300},
    {"mode": "warm", "elapsed_seconds": 1.0, "process_peak_rss_bytes": 350},
    {"mode": "warm", "elapsed_seconds": 3.0, "process_peak_rss_bytes": 375},
  ]

  summary = summarize_runs(runs)

  assert summary == {
    "cold": {
      "repetitions": 2,
      "elapsed_seconds_p50": 3.0,
      "elapsed_seconds_p95": 3.9,
      "process_peak_rss_bytes_max": 400,
    },
    "warm": {
      "repetitions": 2,
      "elapsed_seconds_p50": 2.0,
      "elapsed_seconds_p95": 2.9,
      "process_peak_rss_bytes_max": 375,
    },
  }
