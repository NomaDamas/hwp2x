from __future__ import annotations

import time
from typing import Callable, Optional

from hwp2x.core.models import ConversionStatus, FileResult, ProgressSnapshot


class ProgressTracker:
    """Counts finished files and estimates remaining time from throughput.

    Both successful and failed results count as completed. ``elapsed`` is the
    wall time since construction, and the remaining time is
    ``(total - completed) / (completed / elapsed)``. A zero total (or no
    completed work yet) yields a remaining estimate of ``0.0``.
    """

    def __init__(
        self,
        total: int,
        bytes_before: int,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if total < 0:
            raise ValueError("total must be >= 0")
        self._total = total
        self._bytes_before = bytes_before
        self._clock = clock
        self._started = clock()
        self._completed = 0
        self._failed = 0
        self._bytes_after = bytes_before
        self._current_file: Optional[str] = None

    def update(self, result: FileResult, current_file: Optional[str] = None) -> None:
        self._completed += 1
        if result.status is ConversionStatus.FAILED:
            self._failed += 1
        self._bytes_after += result.target_size - result.source_size
        self._current_file = current_file

    def snapshot(self) -> ProgressSnapshot:
        elapsed = max(0.0, self._clock() - self._started)
        return ProgressSnapshot(
            total=self._total,
            completed=self._completed,
            failed=self._failed,
            bytes_before=self._bytes_before,
            bytes_after=self._bytes_after,
            elapsed_seconds=elapsed,
            estimated_remaining_seconds=self._remaining(elapsed),
            current_file=self._current_file,
        )

    def _remaining(self, elapsed: float) -> float:
        if self._total == 0 or self._completed == 0 or elapsed <= 0:
            return 0.0
        rate = self._completed / elapsed
        pending = self._total - self._completed
        if pending <= 0:
            return 0.0
        return pending / rate
