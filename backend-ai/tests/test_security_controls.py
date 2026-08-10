from app.security_controls import SlidingWindowRateLimiter


def test_rate_limiter_bounds_requests_per_identity_and_window():
  now = [100.0]
  limiter = SlidingWindowRateLimiter(limit=2, window_seconds=60, clock=lambda: now[0])

  assert limiter.allow("tenant:user") is True
  assert limiter.allow("tenant:user") is True
  assert limiter.allow("tenant:user") is False
  assert limiter.allow("other:user") is True

  now[0] = 161.0
  assert limiter.allow("tenant:user") is True
