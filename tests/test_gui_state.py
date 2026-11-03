import json
import threading
from http.client import HTTPConnection
from pathlib import Path

from hwp2x.core.models import ComparisonResult
from hwp2x.ui.server import AppServer


class FakeConverter:
    def discover(self):
        return []

    def convert(self, source: Path, target: Path) -> None:
        if source.name.startswith("실패"):
            raise RuntimeError("한글 응답 없음")
        target.write_text(source.read_text(encoding="utf-8") + ("차이" if "차이" in source.name else ""), encoding="utf-8")


class FakeComparator:
    def compare(self, source: Path, target: Path) -> ComparisonResult:
        same = "차이" not in source.name
        return ComparisonResult(same, 2, 2, "일치" if same else "문단 차이", ("문단",), ("문단",), () if same else ("문단 텍스트 차이",))


def _server(tmp_path: Path) -> tuple[AppServer, str]:
    server = AppServer("127.0.0.1", 0, tmp_path, 1)
    server.state.converter_factory = FakeConverter
    server.state.comparator_factory = FakeComparator
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"127.0.0.1:{server.server_address[1]}"


def _call(address: str, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    connection = HTTPConnection(address, timeout=5)
    payload = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if payload else {}
    connection.request(method, path, payload, headers)
    response = connection.getresponse()
    return response.status, json.loads(response.read().decode())


def test_gui_state_connects_scan_settings_conversion_and_backup(tmp_path: Path) -> None:
    (tmp_path / "정상.hwp").write_text("본문", encoding="utf-8")
    (tmp_path / "차이.hwp").write_text("본문", encoding="utf-8")
    (tmp_path / "실패.hwp").write_text("본문", encoding="utf-8")
    server, address = _server(tmp_path)
    try:
        status, scanned = _call(address, "POST", "/api/scan", {"root": str(tmp_path)})
        assert status == 200 and scanned["total"] == 3 and scanned["phase"] == "ready"

        status, settings = _call(address, "POST", "/api/settings", {"workers": 2, "autoBackup": False, "backupDir": str(tmp_path / "백업"), "skipExisting": True})
        assert settings["workers"] == 2 and settings["autoBackup"] is False and settings["skipExisting"] is True

        status, started = _call(address, "POST", "/api/start", {"workers": 1, "compare": True, "autoBackup": False})
        assert status == 202 and {"total", "completed", "percent", "elapsed", "remaining", "sizeDelta", "issues"} <= set(started)
        for _ in range(50):
            _, state = _call(address, "GET", "/api/state")
            if state["phase"] == "done":
                break
        else:
            raise AssertionError(state["phase"])

        by_name = {item["name"]: item for item in state["files"]}
        assert by_name["정상.hwp"]["status"] == "ok"
        assert by_name["차이.hwp"]["status"] == "diff" and by_name["차이.hwp"]["checks"]
        assert by_name["실패.hwp"]["status"] == "fail" and "한글" in by_name["실패.hwp"]["message"]
        assert state["issues"] and state["sizeDelta"] != 0

        status, paused = _call(address, "POST", "/api/pause", {})
        assert paused["phase"] == "paused"
        refused, error = _call(address, "POST", "/api/backup-delete", {"consent": False})
        assert refused == 400 and "동의" in error["error"]
        accepted, deleted = _call(address, "POST", "/api/backup-delete", {"consent": True, "backupDir": str(tmp_path / "백업")})
        assert accepted == 200 and deleted["counts"]["deleted"] == 1
        assert not (tmp_path / "정상.hwp").exists()
        assert (tmp_path / "차이.hwp").exists() and (tmp_path / "실패.hwp").exists()
        connection = HTTPConnection(address, timeout=5)
        connection.request("GET", "/app.html")
        page = connection.getresponse()
        assert page.status == 200 and "개요" in page.read().decode()
    finally:
        server.shutdown()
