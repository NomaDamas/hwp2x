from pathlib import Path
from unittest.mock import MagicMock

import pytest

from hwp2x.adapters.hancom_discovery import discover_hancom
from hwp2x.adapters.com_hwp import HancomConverter
from hwp2x.core.errors import ConversionError, ConverterUnavailable
from hwp2x.core.models import HancomInstallation


def _install(root: Path, version: str) -> Path:
    path = root / f"Hwp{version}" / "Hwp.exe"
    path.parent.mkdir()
    path.write_text("fake", encoding="utf-8")
    return path


def test_discovery_puts_newest_available_version_first(tmp_path: Path) -> None:
    _install(tmp_path, "2018")
    newest = _install(tmp_path, "2022")
    found = discover_hancom([tmp_path], platform_name="nt")
    assert found[0].executable == newest


def test_convert_fails_if_target_exists(tmp_path: Path) -> None:
    target = tmp_path / "test.hwpx"
    target.write_text("유지", encoding="utf-8")
    with pytest.raises(ConversionError, match="덮어쓰지 않습니다"):
        HancomConverter().convert(tmp_path / "source.hwp", target)
    assert target.read_text(encoding="utf-8") == "유지"


def test_convert_fails_if_no_hancom_installed(tmp_path: Path) -> None:
    converter = HancomConverter(discovery=lambda: [])
    with pytest.raises(ConverterUnavailable, match="찾지 못했습니다"):
        converter.convert(tmp_path / "source.hwp", tmp_path / "target.hwpx")


def test_convert_fails_on_non_windows_without_dispatcher(tmp_path: Path) -> None:
    installation = HancomInstallation("한컴오피스", "2022", tmp_path / "hwp.exe", True)
    converter = HancomConverter(discovery=lambda: [installation], platform_name="linux")
    with pytest.raises(ConverterUnavailable, match="Windows가 아니어서"):
        converter.convert(tmp_path / "source.hwp", tmp_path / "target.hwpx")


def test_convert_success_with_dispatcher(tmp_path: Path) -> None:
    source, target = tmp_path / "source.hwp", tmp_path / "target.hwpx"
    source.write_text("원본", encoding="utf-8")
    mock_hwp = MagicMock()
    mock_hwp.SaveAs.side_effect = lambda path, *_args: Path(path).write_text("변환", encoding="utf-8")
    installation = HancomInstallation("한컴오피스", "2022", tmp_path / "hwp.exe", True)
    converter = HancomConverter(discovery=lambda: [installation], dispatcher=lambda: mock_hwp, platform_name="nt")

    converter.convert(source, target)

    mock_hwp.Open.assert_called_once()
    mock_hwp.SaveAs.assert_called_once()
    mock_hwp.Quit.assert_called_once()
    assert target.read_text(encoding="utf-8") == "변환"
