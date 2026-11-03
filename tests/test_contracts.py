from pathlib import Path

from hwp2x.core.contracts import Comparator, Converter
from hwp2x.core.models import (
    BackupResult,
    ComparisonResult,
    ConversionStatus,
    FileResult,
    HancomInstallation,
    HwpFile,
    OperationPhase,
)


class FakeConverter:
    def discover(self) -> list[HancomInstallation]:
        return [HancomInstallation("한글", "2022", Path("Hwp.exe"))]

    def convert(self, source: Path, target: Path) -> None:
        target.write_bytes(source.read_bytes())


class FakeComparator:
    def compare(self, source: Path, target: Path) -> ComparisonResult:
        same = source.read_bytes() == target.read_bytes()
        return ComparisonResult(same, 1, 1, "동일" if same else "차이", ("문단",), ("문단",))


def test_shared_results_cover_scan_conversion_verification_and_backup(tmp_path: Path) -> None:
    source = tmp_path / "문서.hwp"
    source.write_text("내용", encoding="utf-8")
    item = HwpFile(source, source.stat().st_size)
    converter: Converter = FakeConverter()
    comparator: Comparator = FakeComparator()

    assert item.target.suffix == ".hwpx"
    converter.convert(item.source, item.target)
    comparison = comparator.compare(item.source, item.target)
    result = FileResult(item.source, item.target, ConversionStatus.VERIFIED, item.size_bytes, item.target.stat().st_size, comparison.reason, comparison.lossless)
    backup = BackupResult(item.source, tmp_path / "백업" / item.source.name, True, "백업 후 삭제")

    assert OperationPhase.DONE.value == "done"
    assert comparison.lossless and result.status is ConversionStatus.VERIFIED
    assert backup.deleted and backup.backup.name == "문서.hwp"


def test_external_integrations_are_replaceable(tmp_path: Path) -> None:
    source = tmp_path / "sample.hwp"
    target = tmp_path / "sample.hwpx"
    source.write_text("a", encoding="utf-8")
    target.write_text("b", encoding="utf-8")

    class OtherConverter(FakeConverter):
        def discover(self) -> list[HancomInstallation]:
            return []

    class OtherComparator(FakeComparator):
        def compare(self, source: Path, target: Path) -> ComparisonResult:
            return ComparisonResult(False, 1, 1, "내용 차이", ("표",), ("문단",), ("표가 문단으로 바뀜",))

    converter: Converter = OtherConverter()
    comparator: Comparator = OtherComparator()
    assert converter.discover() == []
    assert comparator.compare(source, target).details == ("표가 문단으로 바뀜",)
