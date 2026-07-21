from dataclasses import dataclass

from codegate_api.knowledge.schemas import AccessLevel, Editability, ManifestEntry, WriteAccess


@dataclass(frozen=True, slots=True)
class AccessContext:
    """Authorization result created by a trusted authentication adapter."""

    subject_id: str | None
    readable_access: frozenset[AccessLevel]
    writable_document_ids: frozenset[str]

    @classmethod
    def anonymous(cls) -> "AccessContext":
        return cls(
            subject_id=None,
            readable_access=frozenset({AccessLevel.PUBLIC}),
            writable_document_ids=frozenset(),
        )

    def can_read(self, document: ManifestEntry) -> bool:
        return document.access in self.readable_access

    def can_write(self, document: ManifestEntry) -> bool:
        return (
            self.subject_id is not None
            and document.id in self.writable_document_ids
            and document.write_access is WriteAccess.ALLOWED
            and document.editability is Editability.EDITABLE
        )
