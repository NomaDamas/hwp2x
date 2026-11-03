from pathlib import Path

import pytest

from hwp2x.adapters.rhwp_compare import RhwpComparator
from hwp2x.core.errors import ConverterUnavailable
from hwp2x.core.models import ConversionStatus, HwpFile, ScanOptions
from hwp2x.core.scanner import scan_hwp_files
from hwp2x.service.batch import BatchConverter, remove_lossless_originals


def test_scan_finds_hwp_case_insensitively(tmp_path: Path) -> None:
    (tmp_path / "a.HWP").write_text("a", encoding="utf-8")
    (tmp_path / "b.txt").write_text("b", encoding="utf-8")
    nested = tmp_path / "nested"
    nested.mkdir()
    (nested / "c.hwp").write_text("c", encoding="utf-8")

    found = scan_hwp_files(ScanOptions(tmp_path))

    assert [item.source.name for item in found] == ["a.HWP", "c.hwp"]


def test_scan_honors_non_recursive_and_excluded_dirs(tmp_path: Path) -> None:
    (tmp_path / "top.hwp").write_text("top", encoding="utf-8")
    blocked = tmp_path / "$Recycle.Bin"
    blocked.mkdir()
    (blocked / "secret.hwp").write_text("secret", encoding="utf-8")

    found = scan_hwp_files(ScanOptions(tmp_path, recursive=False))

    assert [item.source.name for item in found] == ["top.hwp"]
    assert scan_hwp_files(ScanOptions(tmp_path)) == [] or "secret.hwp" not in [item.source.name for item in scan_hwp_files(ScanOptions(tmp_path))]


def test_conversion_records_progress_and_size(tmp_path: Path) -> None:
    source = tmp_path / "sample.hwp"
    source.write_bytes(b"12345")

    class FakeConverter:
        def convert(self, source: Path, target: Path) -> None:
            target.write_bytes(b"12345678")

    snapshots = []
    result = BatchConverter(FakeConverter(), max_workers=1).run(
        [HwpFile(source, source.stat().st_size)], lambda snapshot, _: snapshots.append(snapshot)
    )[0]

    assert result.status is ConversionStatus.COMPLETED
    assert result.target_size == 8
    assert snapshots[-1].percent == 100
    assert snapshots[-1].size_delta == 3


def test_existing_target_is_not_overwritten(tmp_path: Path) -> None:
    source = tmp_path / "sample.hwp"
    source.write_text("source", encoding="utf-8")
    target = source.with_suffix(".hwpx")
    target.write_text("keep", encoding="utf-8")

    class FakeConverter:
        def convert(self, source: Path, target: Path) -> None:
            raise AssertionError("existing target must not be replaced")

    result = BatchConverter(FakeConverter()).run([HwpFile(source, 6)])[0]

    assert result.status is ConversionStatus.SKIPPED
    assert target.read_text(encoding="utf-8") == "keep"


def test_rhwp_comparison_controls_original_deletion(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "sample.hwp"
    source.write_text("same", encoding="utf-8")

    class FakeConverter:
        def convert(self, source: Path, target: Path) -> None:
            target.write_text("converted", encoding="utf-8")

    class Document:
        def __init__(self, text: str) -> None:
            self.text = text
        def extract_text(self) -> str:
            return self.text

    monkeypatch.setattr("importlib.import_module", lambda name: type("rhwp", (), {"parse": staticmethod(lambda path: Document(Path(path).read_text(encoding="utf-8")))}))
    comparator = RhwpComparator()
    monkeypatch.setattr(comparator, "compare", lambda source, target: type("Result", (), {"lossless": True, "reason": "동일"})())
    result = BatchConverter(FakeConverter(), comparator).run([HwpFile(source, 4)])[0]

    assert result.lossless is True
    assert remove_lossless_originals([result]) == [source]
    assert not source.exists()


def test_hancom_converter_reports_unavailable_outside_windows() -> None:
    from hwp2x.adapters.com_hwp import HancomConverter

    if __import__("os").name == "nt":
        pytest.skip("Windows COM availability depends on the installed Hancom application")
    with pytest.raises(ConverterUnavailable):
        HancomConverter().convert("source.hwp", "source.hwpx")
