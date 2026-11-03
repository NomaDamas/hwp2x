from __future__ import annotations

from pathlib import Path
from typing import Protocol

from hwp2x.core.models import ComparisonResult, HancomInstallation


class Converter(Protocol):
    """HWP를 HWPX로 저장하는 교체 가능한 변환기."""

    def discover(self) -> list[HancomInstallation]: ...

    def convert(self, source: Path, target: Path) -> None: ...


class Comparator(Protocol):
    """원본과 변환본을 비교하는 교체 가능한 검증기."""

    def compare(self, source: Path, target: Path) -> ComparisonResult: ...
