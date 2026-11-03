from pathlib import Path

from hwp2x.cli import main
from hwp2x.ui.desktop import DesktopApp
from hwp2x.ui.server import AppServer


def test_desktop_uses_app_window_without_browser(monkeypatch, tmp_path: Path) -> None:
    opened = []
    monkeypatch.setattr("hwp2x.ui.desktop._webview_window", lambda url, close: opened.append((url, close)))
    monkeypatch.setattr("webbrowser.open", lambda url: (_ for _ in ()).throw(AssertionError(url)))
    app = DesktopApp(AppServer("127.0.0.1", 0, tmp_path, 1))
    app.run()
    assert opened[0][0].endswith("/app.html")
    opened[0][1]()


def test_scan_only_does_not_open_window(monkeypatch, tmp_path: Path, capsys) -> None:
    (tmp_path / "문서.hwp").write_text("sample", encoding="utf-8")
    monkeypatch.setattr("hwp2x.ui.desktop.DesktopApp.run", lambda self: (_ for _ in ()).throw(AssertionError("window")))
    assert main(["--scan-only", "--root", str(tmp_path)]) == 0
    assert "문서.hwp" in capsys.readouterr().out
