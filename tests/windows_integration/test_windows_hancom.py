from __future__ import annotations

import os
import threading
import urllib.request
from pathlib import Path

import pytest

from hwp2x.adapters.com_hwp import HancomConverter
from hwp2x.adapters.hancom_discovery import discover_hancom
from hwp2x.adapters.rhwp_compare import RhwpComparator
from hwp2x.core.errors import OptionalDependencyUnavailable
from hwp2x.ui.server import AppServer

pytestmark = [
    pytest.mark.windows_integration,
    pytest.mark.skipif(os.name != "nt", reason="한컴 COM 통합 검사는 Windows에서만 실행합니다"),
]


def _real_hwp() -> Path:
    value = os.environ.get("HWP2X_INTEGRATION_HWP", "").strip()
    if not value:
        pytest.skip("HWP2X_INTEGRATION_HWP에 실제 HWP 파일 경로가 필요합니다")
    path = Path(value)
    if not path.is_file() or path.suffix.casefold() != ".hwp":
        pytest.skip("HWP2X_INTEGRATION_HWP가 실제 .hwp 파일이 아닙니다")
    return path


def test_installed_hancom_is_detected() -> None:
    found = discover_hancom(platform_name="nt")
    assert found, "한컴오피스 한글 설치를 찾지 못했습니다"
    assert found[0].available
    assert found[0].executable.is_file()
    assert found[0].version


def test_gui_state_endpoint_reports_detected_hancom(tmp_path: Path) -> None:
    server = AppServer("127.0.0.1", 0, tmp_path, 1)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        with urllib.request.urlopen(f"http://{host}:{port}/api/state", timeout=10) as response:
            assert response.status == 200
            body = response.read().decode("utf-8")
        assert '"hancomAvailable":true' in body
        assert '"installations"' in body
    finally:
        server.shutdown()
        thread.join(timeout=10)
        server.server_close()


def test_real_hwp_conversion_and_lossless_comparison(tmp_path: Path) -> None:
    source = _real_hwp()
    target = tmp_path / f"{source.stem}.hwpx"
    HancomConverter(platform_name="nt").convert(source, target)
    assert target.is_file()
    assert target.stat().st_size > 0

    try:
        comparison = RhwpComparator().compare(source, target)
    except OptionalDependencyUnavailable as exc:
        pytest.fail(f"실제 변환 검증에 필요한 rhwp-python이 없습니다: {exc}")
    assert comparison.lossless is True
    assert comparison.details == ()
