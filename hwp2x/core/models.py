from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Optional


class ConversionStatus(str, Enum):
    PENDING = "pending"
    CONVERTING = "converting"
    VERIFIED = "verified"
    DIFFERENT = "different"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"
    DELETED = "deleted"


class OperationPhase(str, Enum):
    IDLE = "idle"
    SCANNING = "scanning"
    READY = "ready"
    CONVERTING = "converting"
    PAUSED = "paused"
    DONE = "done"


@dataclass(frozen=True)
class HancomInstallation:
    name: str
    version: str
    executable: Path
    available: bool = True


@dataclass(frozen=True)
class ComparisonResult:
    lossless: bool
    source_text_length: int
    target_text_length: int
    reason: str
    source_structure: tuple[str, ...] = ()
    target_structure: tuple[str, ...] = ()
    details: tuple[str, ...] = ()


@dataclass(frozen=True)
class BackupResult:
    source: Path
    backup: Path
    deleted: bool
    message: str

@dataclass(frozen=True)
class HwpFile:
    source: Path
    size_bytes: int

    @property
    def target(self) -> Path:
        return self.source.with_suffix(".hwpx")


@dataclass
class FileResult:
    source: Path
    target: Optional[Path]
    status: ConversionStatus
    source_size: int = 0
    target_size: int = 0
    message: str = ""
    lossless: Optional[bool] = None


@dataclass
class ProgressSnapshot:
    total: int
    completed: int
    failed: int
    bytes_before: int
    bytes_after: int
    elapsed_seconds: float
    estimated_remaining_seconds: Optional[float]
    current_file: Optional[str] = None

    @property
    def percent(self) -> float:
        return 100.0 if self.total == 0 else min(100.0, self.completed / self.total * 100)

    @property
    def size_delta(self) -> int:
        return self.bytes_after - self.bytes_before


@dataclass
class ScanOptions:
    root: Path
    recursive: bool = True
    excluded_dirs: set[str] = field(default_factory=lambda: {"$recycle.bin", "system volume information"})
