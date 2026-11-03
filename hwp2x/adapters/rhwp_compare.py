"""rhwp로 HWP와 HWPX의 글자와 문서 구조를 비교한다."""

from __future__ import annotations

import importlib
import re
from os import PathLike
from pathlib import Path
from typing import Any, Callable

from hwp2x.core.errors import ComparisonError, OptionalDependencyUnavailable
from hwp2x.core.models import ComparisonResult


MINIMUM_VERSION = (0, 8)
STRUCTURE_FIELDS = (
    ("표", ("tables",)),
    ("그림·개체", ("pictures", "images", "shapes")),
    ("글자·문단 모양", ("styles", "char_shapes")),
    ("머리말·꼬리말·각주", ("headers", "footnotes")),
)


class RhwpComparator:
    """rhwp가 있을 때만 원본과 변환본이 같은지 판정한다."""

    def __init__(self, loader: Callable[[str], Any] | None = None) -> None:
        self.loader = loader or importlib.import_module

    def compare(self, source: str | PathLike[str], target: str | PathLike[str]) -> ComparisonResult:
        rhwp = self._load()
        source_path, target_path = Path(source), Path(target)
        try:
            source_document = self._parse(rhwp, source_path)
            target_document = self._parse(rhwp, target_path)
            source_text = _normalize(self._extract_text(source_document))
            target_text = _normalize(self._extract_text(target_document))
            source_structure = self._structure(source_document)
            target_structure = self._structure(target_document)
        except (OptionalDependencyUnavailable, ComparisonError):
            raise
        except Exception as exc:
            raise ComparisonError(f"손상된 파일이라 비교할 수 없습니다: {source_path.name}, {target_path.name}") from exc

        details = []
        if source_text != target_text:
            details.append("문단 텍스트가 다릅니다")
        for label, left, right in zip((label for label, _ in STRUCTURE_FIELDS), source_structure, target_structure):
            if left != right:
                details.append(f"{label}가 다릅니다")
        lossless = not details
        return ComparisonResult(
            lossless=lossless,
            source_text_length=len(source_text),
            target_text_length=len(target_text),
            reason="문단과 구조가 같습니다" if lossless else details[0],
            source_structure=tuple(f"{label}:{value}" for (label, _), value in zip(STRUCTURE_FIELDS, source_structure)),
            target_structure=tuple(f"{label}:{value}" for (label, _), value in zip(STRUCTURE_FIELDS, target_structure)),
            details=tuple(details),
        )

    def _load(self) -> Any:
        try:
            rhwp = self.loader("rhwp")
        except Exception as exc:
            raise OptionalDependencyUnavailable("rhwp가 설치되어 있지 않습니다. 검증 엔진을 설치한 뒤 다시 비교하세요.") from exc
        version = getattr(rhwp, "__version__", None) or getattr(rhwp, "version", None)
        if version is not None and _version_tuple(str(version)) < MINIMUM_VERSION:
            raise OptionalDependencyUnavailable(f"rhwp 버전이 맞지 않습니다. {version} 대신 0.8 이상이 필요합니다.")
        if not callable(getattr(rhwp, "parse", None)):
            raise OptionalDependencyUnavailable("설치된 rhwp 버전이 맞지 않습니다. parse 기능이 없습니다.")
        return rhwp

    @staticmethod
    def _parse(rhwp: Any, path: Path) -> Any:
        if not path.is_file():
            raise ComparisonError(f"손상된 파일이라 비교할 수 없습니다: {path.name}")
        try:
            return rhwp.parse(str(path))
        except ComparisonError:
            raise
        except Exception as exc:
            raise ComparisonError(f"손상된 파일이라 비교할 수 없습니다: {path.name}") from exc

    @staticmethod
    def _extract_text(document: Any) -> str:
        extractor = getattr(document, "extract_text", None)
        if callable(extractor):
            value = extractor()
            if not isinstance(value, str):
                raise ComparisonError("손상된 파일이라 글자를 읽지 못했습니다")
            return value
        paragraphs = getattr(document, "paragraphs", None)
        if paragraphs is None:
            raise ComparisonError("손상된 파일이라 문단을 읽지 못했습니다")
        if callable(paragraphs):
            paragraphs = paragraphs()
        try:
            return "\n".join(_paragraph_text(item) for item in paragraphs)
        except TypeError as exc:
            raise ComparisonError("손상된 파일이라 문단을 읽지 못했습니다") from exc

    @staticmethod
    def _structure(document: Any) -> tuple[str, ...]:
        values = []
        for _label, names in STRUCTURE_FIELDS:
            raw = None
            for name in names:
                if hasattr(document, name):
                    raw = getattr(document, name)
                    break
            if callable(raw):
                raw = raw()
            if raw is None:
                values.append("")
            elif isinstance(raw, str):
                values.append(_normalize(raw))
            else:
                values.append(_normalize("\n".join(str(item) for item in raw)))
        return tuple(values)


def _paragraph_text(paragraph: Any) -> str:
    if isinstance(paragraph, str):
        return paragraph
    text = getattr(paragraph, "text", None)
    return text if isinstance(text, str) else str(paragraph)


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _version_tuple(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", value)[:3]) or (0,)
