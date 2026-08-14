"""Canonical serialization and identity helpers for deck manifests."""

import hashlib
import json

from impromptu_ingestion.contracts import DeckManifest


def canonical_manifest_bytes(manifest: DeckManifest) -> bytes:
    """Serialize a manifest without platform- or locale-dependent variation."""
    payload = manifest.model_dump(mode="json")
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return encoded.encode("utf-8") + b"\n"


def manifest_sha256(manifest: DeckManifest) -> str:
    """Return the lowercase SHA-256 of canonical manifest bytes."""
    return hashlib.sha256(canonical_manifest_bytes(manifest)).hexdigest()


def deck_id(source_sha256: str) -> str:
    """Build the immutable content-addressed deck identity."""
    return f"deck_{source_sha256}"


def slide_key(source_sha256: str, source_id: str) -> str:
    """Build a stable slide identity within an immutable source deck."""
    identity = f"impromptu-slide-v1\0{source_sha256}\0{source_id}".encode()
    return f"slide_{hashlib.sha256(identity).hexdigest()}"
