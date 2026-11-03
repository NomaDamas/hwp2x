from __future__ import annotations

import os
import threading
import webbrowser
from typing import Any, Callable

from hwp2x.ui.server import AppServer


class DesktopApp:
    def __init__(self, server: AppServer, window_factory: Callable[..., Any] | None = None) -> None:
        self.server = server
        self.window_factory = window_factory or _webview_window
        self.thread: threading.Thread | None = None

    def start(self) -> str:
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address
        return f"http://{host}:{port}/app.html"

    def run(self) -> None:
        url = self.start()
        self.window_factory(url, self.server.shutdown)


def _webview_window(url: str, on_close: Callable[[], None]) -> None:
    if os.name == "nt" and not _dotnet_runtime_installed():
        webbrowser.open(url)
        try:
            input("hwp2x 창을 닫으려면 Enter를 누르세요.\n")
        finally:
            on_close()
        return

    try:
        import webview
    except ImportError as exc:
        raise RuntimeError("자체 창 실행에는 pywebview가 필요합니다") from exc
    window = webview.create_window("hwp2x", url, width=1280, height=860)
    window.events.closed += on_close
    webview.start()


def _dotnet_runtime_installed() -> bool:
    windir = os.environ.get("WINDIR", r"C:\Windows")
    framework = os.path.join(windir, "Microsoft.NET", "Framework64")
    try:
        return any(name.startswith("v4") for name in os.listdir(framework))
    except OSError:
        return False
