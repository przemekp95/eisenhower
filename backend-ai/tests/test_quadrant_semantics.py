from app.defaults import get_quadrant_name
from app.service import quadrant_to_flags


def test_quadrant_names_match_urgency_and_importance_semantics():
  assert quadrant_to_flags(0) == (True, True)
  assert get_quadrant_name(0, "en") == "Do Now"

  assert quadrant_to_flags(1) == (True, False)
  assert get_quadrant_name(1, "en") == "Delegate"
  assert get_quadrant_name(1, "pl") == "Deleguj"

  assert quadrant_to_flags(2) == (False, True)
  assert get_quadrant_name(2, "en") == "Schedule"
  assert get_quadrant_name(2, "pl") == "Zaplanuj"

  assert quadrant_to_flags(3) == (False, False)
  assert get_quadrant_name(3, "en") == "Delete"
