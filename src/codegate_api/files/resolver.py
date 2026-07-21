from pathlib import Path
from urllib.parse import unquote, urlparse


class SourceResolutionError(ValueError):
    """Raised when a source URI cannot be resolved inside the allowed root."""


class SourceUriResolver:
    def __init__(self, source_root: Path) -> None:
        self._source_root = source_root.resolve()

    def resolve(self, source_uri: str) -> Path:
        parsed = urlparse(source_uri)
        if parsed.scheme != "source":
            raise SourceResolutionError("only source:// URIs are allowed")

        relative = unquote(f"{parsed.netloc}{parsed.path}").lstrip("/")
        if not relative:
            raise SourceResolutionError("source URI must include a relative path")

        candidate = (self._source_root / relative).resolve()
        if not candidate.is_relative_to(self._source_root):
            raise SourceResolutionError("source URI escapes the allowed root")
        return candidate
