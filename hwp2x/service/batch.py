from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable, Optional, Protocol

from hwp2x.core.errors import ComparisonError, ConversionError, OptionalDependencyUnavailable
from hwp2x.core.models import ConversionStatus, FileResult, HwpFile
from hwp2x.core.progress import ProgressTracker


class Converter(Protocol):
    def convert(self, source: Path, target: Path) -> None: ...


class Comparator(Protocol):
    def compare(self, source: Path, target: Path) -> object: ...


ProgressCallback = Callable[[object, FileResult], None]


class BatchConverter:
    def __init__(
        self,
        converter: Converter,
        comparator: Optional[Comparator] = None,
        max_workers: int = 1,
    ) -> None:
        if max_workers < 1:
            raise ValueError("동시 작업 수는 1 이상이어야 합니다")
        self.converter = converter
        self.comparator = comparator
        self.max_workers = max_workers

    def run(
        self,
        files: list[HwpFile],
        progress_callback: Optional[ProgressCallback] = None,
        cancel_event: Optional[threading.Event] = None,
    ) -> list[FileResult]:
        tracker = ProgressTracker(len(files), sum(item.size_bytes for item in files))
        results: list[Optional[FileResult]] = [None] * len(files)
        pending = [(index, item) for index, item in enumerate(files)]

        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = {}
            while pending and not (cancel_event and cancel_event.is_set()):
                index, item = pending.pop(0)
                futures[executor.submit(self._convert_one, item)] = index
            for index, item in pending:
                results[index] = self._result(item, ConversionStatus.SKIPPED, "사용자가 변환을 중지했습니다")
            for future in as_completed(futures):
                index = futures[future]
                item = files[index]
                try:
                    result = future.result()
                except Exception as exc:
                    result = self._result(item, ConversionStatus.FAILED, self._message(exc))
                results[index] = result
                tracker.update(result, str(item.source))
                if progress_callback:
                    progress_callback(tracker.snapshot(), result)
        return [result for result in results if result is not None]

    def _convert_one(self, item: HwpFile) -> FileResult:
        if item.target.exists():
            return self._result(item, ConversionStatus.SKIPPED, "같은 이름의 HWPX 파일이 이미 있습니다")
        self.converter.convert(item.source, item.target)
        if not item.target.is_file():
            return self._result(item, ConversionStatus.FAILED, "HWPX 파일이 만들어지지 않았습니다")
        result = self._result(item, ConversionStatus.COMPLETED, "변환 완료")
        result.target_size = item.target.stat().st_size
        if self.comparator is not None:
            comparison = self.comparator.compare(item.source, item.target)
            result.lossless = bool(getattr(comparison, "lossless"))
            result.status = ConversionStatus.VERIFIED if result.lossless else ConversionStatus.COMPLETED
            result.message = str(getattr(comparison, "reason", "비교 완료"))
        return result

    @staticmethod
    def _result(item: HwpFile, status: ConversionStatus, message: str) -> FileResult:
        return FileResult(
            source=item.source,
            target=item.target,
            status=status,
            source_size=item.size_bytes,
            message=message,
        )

    @staticmethod
    def _message(exc: Exception) -> str:
        if isinstance(exc, (ConversionError, ComparisonError, OptionalDependencyUnavailable)):
            return str(exc)
        return f"변환 중 오류가 발생했습니다: {exc}"


def remove_lossless_originals(results: list[FileResult]) -> list[Path]:
    deleted: list[Path] = []
    for result in results:
        if result.lossless is not True or result.target is None:
            continue
        if result.source.is_file() and result.target.is_file():
            result.source.unlink()
            deleted.append(result.source)
    return deleted
