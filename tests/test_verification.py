from pathlib import Path

import pytest

from hwp2x.adapters.rhwp_compare import RhwpComparator
from hwp2x.core.errors import ComparisonError, OptionalDependencyUnavailable
from hwp2x.core.models import ConversionStatus, FileResult
from hwp2x.service.batch import remove_lossless_originals


class Document:
    def __init__(self, text: str, tables: str = "표1", pictures: str = "그림1") -> None:
        self.text = text
        self.tables = tables
        self.pictures = pictures

    def extract_text(self) -> str:
        return self.text


class Rhwp:
    __version__ = "0.8.1"

    def __init__(self, documents: dict[str, Document]) -> None:
        self.documents = documents

    def parse(self, path: str) -> Document:
        if path not in self.documents:
            raise ValueError("손상된 OLE 파일")
        return self.documents[path]


def test_missing_wrong_version_and_damaged_files_are_distinct(tmp_path: Path) -> None:
    source, target = tmp_path / "원본.hwp", tmp_path / "원본.hwpx"
    source.write_text("원본", encoding="utf-8")
    target.write_text("변환", encoding="utf-8")

    with pytest.raises(OptionalDependencyUnavailable, match="설치되어 있지 않습니다"):
        RhwpComparator(loader=lambda name: (_ for _ in ()).throw(ModuleNotFoundError(name))).compare(source, target)

    old = Rhwp({str(source): Document("가"), str(target): Document("가")})
    old.__version__ = "0.7.0"
    with pytest.raises(OptionalDependencyUnavailable, match="버전이 맞지 않습니다"):
        RhwpComparator(loader=lambda name: old).compare(source, target)

    damaged = Rhwp({})
    with pytest.raises(ComparisonError, match="손상된 파일"):
        RhwpComparator(loader=lambda name: damaged).compare(source, target)


def test_text_and_structure_are_returned_for_the_screen(tmp_path: Path) -> None:
    source, target = tmp_path / "원본.hwp", tmp_path / "원본.hwpx"
    source.write_bytes(b"hwp")
    target.write_bytes(b"hwpx")
    rhwp = Rhwp({str(source): Document("본문", "표1", "그림1"), str(target): Document("본문", "표2", "그림1")})

    result = RhwpComparator(loader=lambda name: rhwp).compare(source, target)

    assert result.lossless is False
    assert result.source_text_length == result.target_text_length == 2
    assert result.details == ("표가 다릅니다",)
    assert result.source_structure[0] == "표:표1"
    assert result.target_structure[0] == "표:표2"


def test_only_lossless_result_can_be_deleted(tmp_path: Path) -> None:
    lossless = tmp_path / "같은.hwp"
    different = tmp_path / "다른.hwp"
    lossless.write_text("원본", encoding="utf-8")
    different.write_text("원본", encoding="utf-8")
    results = [
        FileResult(lossless, tmp_path / "같은.hwpx", ConversionStatus.VERIFIED, lossless=True),
        FileResult(different, tmp_path / "다른.hwpx", ConversionStatus.DIFFERENT, lossless=False),
    ]
    results[0].target.write_text("변환", encoding="utf-8")
    results[1].target.write_text("변환", encoding="utf-8")

    assert remove_lossless_originals(results) == [lossless]
    assert not lossless.exists()
    assert different.exists()
