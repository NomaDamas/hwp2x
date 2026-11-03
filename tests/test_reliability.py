import os
import stat
import threading
from pathlib import Path

import pytest

from hwp2x.core import scanner
from hwp2x.core.models import ConversionStatus, FileResult, HwpFile, ScanOptions
from hwp2x.core.scanner import scan_hwp_files
from hwp2x.service.batch import BatchConverter, remove_lossless_originals


class SelectiveConverter:
    def __init__(self) -> None:
        self.calls: list[Path] = []
        self.lock = threading.Lock()

    def convert(self, source: Path, target: Path) -> None:
        with self.lock:
            self.calls.append(source)
        if "실패" in source.name:
            raise RuntimeError("변환 실패")
        target.write_bytes(source.read_bytes())



def test_empty_directory_returns_no_files(tmp_path: Path) -> None:
    assert scan_hwp_files(ScanOptions(tmp_path)) == []


def test_unreadable_directory_is_skipped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    visible = tmp_path / "보임.hwp"
    visible.write_text("보임", encoding="utf-8")
    blocked = tmp_path / "권한없음"
    blocked.mkdir()
    (blocked / "숨김.hwp").write_text("숨김", encoding="utf-8")
    real_iterdir = Path.iterdir

    def guarded_iterdir(directory: Path):
        if directory == blocked:
            raise PermissionError(directory)
        return real_iterdir(directory)

    monkeypatch.setattr(scanner.Path, "iterdir", guarded_iterdir)
    os.chmod(blocked, 0)
    try:
        found = scan_hwp_files(ScanOptions(tmp_path))
    finally:
        os.chmod(blocked, stat.S_IRWXU)
    assert [item.source.name for item in found] == ["보임.hwp"]


def test_retry_keeps_successful_hwpx_unchanged(tmp_path: Path) -> None:
    done_source = tmp_path / "완료.hwp"
    failed_source = tmp_path / "실패.hwp"
    done_source.write_text("성공", encoding="utf-8")
    failed_source.write_text("실패", encoding="utf-8")
    done_target = done_source.with_suffix(".hwpx")
    done_target.write_bytes(b"keep-me")
    files = [HwpFile(done_source, 4), HwpFile(failed_source, 4)]

    first_converter = SelectiveConverter()
    first = BatchConverter(first_converter).run(files)
    assert first[0].status is ConversionStatus.SKIPPED
    assert first[1].status is ConversionStatus.FAILED
    assert first_converter.calls == [failed_source]
    assert done_target.read_bytes() == b"keep-me"

    class RetryConverter(SelectiveConverter):
        def convert(self, source: Path, target: Path) -> None:
            with self.lock:
                self.calls.append(source)
            target.write_text("다시 성공", encoding="utf-8")

    retry_converter = RetryConverter()
    second = BatchConverter(retry_converter).run(files)
    assert second[0].status is ConversionStatus.SKIPPED
    assert second[1].status is ConversionStatus.COMPLETED
    assert retry_converter.calls == [failed_source]
    assert done_target.read_bytes() == b"keep-me"
    assert failed_source.with_suffix(".hwpx").read_text(encoding="utf-8") == "다시 성공"


def test_non_lossless_original_survives_cleanup(tmp_path: Path) -> None:
    source = tmp_path / "차이.hwp"
    target = source.with_suffix(".hwpx")
    source.write_text("원본", encoding="utf-8")
    target.write_text("변환", encoding="utf-8")
    result = FileResult(source, target, ConversionStatus.DIFFERENT, lossless=False)

    assert remove_lossless_originals([result]) == []
    assert source.read_text(encoding="utf-8") == "원본"


def test_parallel_conversion_returns_every_input(tmp_path: Path) -> None:
    files = []
    for index in range(6):
        source = tmp_path / f"문서{index}.hwp"
        source.write_text(str(index), encoding="utf-8")
        files.append(HwpFile(source, source.stat().st_size))

    results = BatchConverter(SelectiveConverter(), max_workers=3).run(files)

    assert len(results) == 6
    assert {item.status for item in results} == {ConversionStatus.COMPLETED}


@pytest.mark.parametrize("workers", [0, -1])
def test_invalid_worker_count_is_rejected(workers: int) -> None:
    with pytest.raises(ValueError, match="1 이상"):
        BatchConverter(SelectiveConverter(), max_workers=workers)
