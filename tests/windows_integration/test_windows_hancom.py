from __future__ import annotations

import json
import os
import threading
import time
import urllib.request
from pathlib import Path

import pytest

from hwp2x.adapters.com_hwp import HancomConverter
from hwp2x.adapters.hancom_discovery import discover_hancom
from hwp2x.adapters.rhwp_compare import RhwpComparator
from hwp2x.core.errors import OptionalDependencyUnavailable
from hwp2x.core.models import ComparisonResult
from hwp2x.ui.server import AppServer

pytestmark = pytest.mark.windows_integration


class FixtureConverter:
    def convert(self, source: Path, target: Path) -> None:
        target.write_bytes(source.read_bytes())


class FixtureComparator:
    def compare(self, source: Path, target: Path) -> ComparisonResult:
        return ComparisonResult(
            lossless=source.read_bytes() == target.read_bytes(),
            source_text_length=source.stat().st_size,
            target_text_length=target.stat().st_size,
            reason="비교 완료",
        )


def _post(url: str, body: dict[str, object]) -> tuple[int, dict[str, object]]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def _server_url(server: AppServer) -> str:
    host, port = server.server_address
    return f"http://{host}:{port}"


def test_desktop_app_server_port_responds_before_window_closes(tmp_path: Path) -> None:
    observed: dict[str, object] = {}

    def window_factory(url: str, on_close: object) -> None:
        with urllib.request.urlopen(url.replace("/app.html", "/api/state"), timeout=10) as response:
            observed["status"] = response.status
            observed["state"] = json.loads(response.read().decode("utf-8"))
        assert callable(on_close)
        on_close()

    server = AppServer("127.0.0.1", 0, tmp_path, 1)
    app = __import__("hwp2x.ui.desktop", fromlist=["DesktopApp"]).DesktopApp(server, window_factory)
    app.run()
    assert observed["status"] == 200
    assert observed["state"]["phase"] == "idle"
    assert app.thread is not None
    app.thread.join(timeout=10)
    assert not app.thread.is_alive()
def test_mocked_windows_flow_scans_converts_verifies_and_backs_up(tmp_path: Path) -> None:
    source = tmp_path / "문서.hwp"
    source.write_bytes(b"fixture hwp")
    backup = tmp_path / "backup"
    server = AppServer("127.0.0.1", 0, tmp_path, 2)
    server.state.converter_factory = FixtureConverter
    server.state.comparator_factory = FixtureComparator
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = _server_url(server)
        status, scanned = _post(f"{url}/api/scan", {"root": str(tmp_path)})
        assert status == 200
        assert scanned["total"] == 1
        status, started = _post(f"{url}/api/start", {"workers": 2, "compare": True})
        assert status == 202
        assert started["phase"] == "converting"
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            with urllib.request.urlopen(f"{url}/api/state", timeout=10) as response:
                state = json.loads(response.read().decode("utf-8"))
            if state["phase"] == "done":
                break
            time.sleep(0.05)
        assert state["phase"] == "done"
        assert state["completed"] == 1
        assert state["counts"]["ok"] == 1
        assert state["percent"] == 100.0
        target = source.with_suffix(".hwpx")
        assert target.is_file()
        assert source.is_file()

        status, deleted = _post(
            f"{url}/api/backup-delete",
            {"consent": True, "backupDir": str(backup)},
        )
        assert status == 200
        assert len(deleted["moved"]) == 1
        moved = Path(str(deleted["moved"][0]))
        assert not source.exists()
        assert moved.read_bytes() == b"fixture hwp"
        assert target.is_file()
    finally:
        server.shutdown()
        thread.join(timeout=10)
        server.server_close()


@pytest.mark.skipif(os.name != "nt", reason="한컴 COM 통합 검사는 Windows에서만 실행합니다")
def test_installed_hancom_is_detected() -> None:
    found = discover_hancom(platform_name="nt")
    assert found, "한컴오피스 한글 설치를 찾지 못했습니다"
    assert found[0].available
    assert found[0].executable.is_file()
    assert found[0].version


@pytest.mark.skipif(os.name != "nt", reason="한컴 COM 통합 검사는 Windows에서만 실행합니다")
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


def _real_hwp() -> Path:
    value = os.environ.get("HWP2X_INTEGRATION_HWP", "").strip()
    if not value:
        pytest.skip("HWP2X_INTEGRATION_HWP에 실제 HWP 파일 경로가 필요합니다")
    path = Path(value)
    if not path.is_file() or path.suffix.casefold() != ".hwp":
        pytest.skip("HWP2X_INTEGRATION_HWP가 실제 .hwp 파일이 아닙니다")
    return path


@pytest.mark.skipif(os.name != "nt", reason="한컴 COM 통합 검사는 Windows에서만 실행합니다")
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
