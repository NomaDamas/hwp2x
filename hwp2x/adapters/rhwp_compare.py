"""Optional rhwp-based HWP text comparison."""

from __future__ import annotations

import importlib
import re
from dataclasses import dataclass
from os import PathLike
from pathlib import Path
from typing import Any, Iterable

from hwp2x.core.errors import ComparisonError, OptionalDependencyUnavailable


@dataclass(frozen=True)
class ComparisonResult:
    """Normalized text comparison result."""

    lossless: bool
    source_text_length: int
    target_text_length: int
    reason: str


class RhwpComparator:
    """Compare HWP and HWPX text when the optional rhwp package is installed."""

    def compare(
        self, source: str | PathLike[str], target: str | PathLike[str]
    ) -> ComparisonResult:
        try:
            rhwp = importlib.import_module("rhwp")
        except Exception as exc:
            raise OptionalDependencyUnavailable(
                "rhwp comparison requires the optional rhwp package"
            ) from exc

        try:
            source_document = self._parse(rhwp, Path(source))
            target_document = self._parse(rhwp, Path(target))
            source_text = self._normalize(self._extract_text(source_document))
            target_text = self._normalize(self._extract_text(target_document))
        except OptionalDependencyUnavailable:
            raise
        except Exception as exc:
            raise ComparisonError(
                f"Failed to compare {source} and {target} with rhwp: {exc}"
            ) from exc

        lossless = source_text == target_text
        reason = (
            "Normalized text is identical"
            if lossless
            else "Normalized text differs"
        )
        return ComparisonResult(
            lossless=lossless,
            source_text_length=len(source_text),
            target_text_length=len(target_text),
            reason=reason,
        )

    @staticmethod
    def _parse(rhwp: Any, path: Path) -> Any:
        parser = getattr(rhwp, "parse", None)
        if not callable(parser):
            raise OptionalDependencyUnavailable(
                "Installed rhwp package does not provide parse()"
            )
        return parser(str(path))

    @staticmethod
    def _extract_text(document: Any) -> str:
        extractor = getattr(document, "extract_text", None)
        if callable(extractor):
            value = extractor()
            if isinstance(value, str):
                return value
            raise ComparisonError("rhwp extract_text() did not return text")

        paragraphs = getattr(document, "paragraphs", None)
        if paragraphs is None:
            raise OptionalDependencyUnavailable(
                "rhwp parsed document provides neither extract_text() nor paragraphs"
            )
        if callable(paragraphs):
            paragraphs = paragraphs()
        try:
            return "\n".join(RhwpComparator._paragraph_text(item) for item in paragraphs)
        except TypeError as exc:
            raise ComparisonError("rhwp paragraphs is not iterable") from exc

    @staticmethod
    def _paragraph_text(paragraph: Any) -> str:
        if isinstance(paragraph, str):
            return paragraph
        text = getattr(paragraph, "text", None)
        if isinstance(text, str):
            return text
        return str(paragraph)

    @staticmethod
    def _normalize(text: str) -> str:
        return re.sub(r"\s+", " ", text).strip()
