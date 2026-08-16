from __future__ import annotations

from hashlib import sha256

from .models import ChunkRecord, SourceDocument


def build_chunk_records_from_texts(
  document: SourceDocument,
  texts: list[str],
  *,
  embedding_version: str,
  identity_version: str = "",
) -> list[ChunkRecord]:
  records: list[ChunkRecord] = []
  for position, text in enumerate(texts):
    checksum = sha256(text.encode("utf-8")).hexdigest()
    identity_parts = [
      document.tenant_id,
      document.document_id,
      document.content_version,
      embedding_version,
    ]
    if identity_version:
      identity_parts.append(identity_version)
    identity_parts.extend((str(position), checksum))
    identity = "|".join(identity_parts)
    records.append(
      ChunkRecord(
        chunk_id=sha256(identity.encode("utf-8")).hexdigest(),
        document_id=document.document_id,
        tenant_id=document.tenant_id,
        project_id=document.project_id,
        owner_id=document.owner_id,
        source_type=document.source_type,
        source_uri=document.source_uri,
        title=document.title,
        text=text,
        position=position,
        checksum=checksum,
        content_version=document.content_version,
        source_sequence=document.source_sequence,
        embedding_version=embedding_version,
        extraction_contract_version=document.extraction_contract_version,
        extraction_checksum=document.extraction_checksum,
        extractor_name=document.extractor_name,
        extractor_version=document.extractor_version,
        ocr_approval_id=document.ocr_approval_id,
        prompt_injection_detected=document.prompt_injection_detected,
        acl_subjects=document.acl_subjects,
        deleted=document.deleted,
      )
    )
  return records
