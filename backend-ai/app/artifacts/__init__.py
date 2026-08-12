"""Immutable, dependency-light AI candidate artifact contracts."""

from .models import ArtifactReference, CandidateManifest
from .registry import ImmutableArtifactRegistry

__all__ = ["ArtifactReference", "CandidateManifest", "ImmutableArtifactRegistry"]
