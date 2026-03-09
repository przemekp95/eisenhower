DEFAULT_TRAINING_DATA = [
  {"text": "urgent deadline today", "quadrant": 0, "source": "default"},
  {"text": "critical production incident", "quadrant": 0, "source": "default"},
  {"text": "reply to inbox", "quadrant": 1, "source": "default"},
  {"text": "book meeting room", "quadrant": 1, "source": "default"},
  {"text": "prepare strategic roadmap", "quadrant": 2, "source": "default"},
  {"text": "exercise twice a week", "quadrant": 2, "source": "default"},
  {"text": "scroll social media", "quadrant": 3, "source": "default"},
  {"text": "clean random screenshots", "quadrant": 3, "source": "default"},
]

QUADRANT_NAMES = {
  0: "Do Now",
  1: "Schedule",
  2: "Delegate",
  3: "Delete",
}

LOCALIZED_QUADRANT_NAMES = {
  "en": QUADRANT_NAMES,
  "pl": {
    0: "Zrób teraz",
    1: "Zaplanuj",
    2: "Deleguj",
    3: "Usuń",
  },
}


def normalize_language(language: str | None) -> str:
  return "pl" if language == "pl" else "en"


def get_quadrant_name(quadrant: int, language: str | None = None) -> str:
  normalized_language = normalize_language(language)
  localized_names = LOCALIZED_QUADRANT_NAMES[normalized_language]
  return localized_names.get(quadrant, QUADRANT_NAMES[quadrant])
