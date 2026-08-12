from app.defaults import DEFAULT_TRAINING_DATA, QUADRANT_NAMES, get_quadrant_name
from app.service import quadrant_to_flags


def test_direct_four_class_contract_is_consistent_across_names_flags_and_seed_data():
  assert QUADRANT_NAMES == {0: "Do Now", 1: "Delegate", 2: "Schedule", 3: "Delete"}
  assert [get_quadrant_name(index, "pl") for index in range(4)] == [
    "Zrób teraz",
    "Deleguj",
    "Zaplanuj",
    "Usuń",
  ]
  assert [quadrant_to_flags(index) for index in range(4)] == [
    (True, True),
    (True, False),
    (False, True),
    (False, False),
  ]

  examples_by_text = {item["text"]: item["quadrant"] for item in DEFAULT_TRAINING_DATA}
  assert examples_by_text["reply to inbox"] == 1
  assert examples_by_text["book meeting room"] == 1
  assert examples_by_text["prepare strategic roadmap"] == 2
  assert examples_by_text["exercise twice a week"] == 2
