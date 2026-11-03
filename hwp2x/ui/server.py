from __future__ import annotations

import json
import mimetypes
import os
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from hwp2x.adapters.com_hwp import HancomConverter
from hwp2x.adapters.rhwp_compare import RhwpComparator
from hwp2x.core.models import HwpFile, ProgressSnapshot, ScanOptions
from hwp2x.core.progress import ProgressTracker
from hwp2x.core.scanner import scan_hwp_files
from hwp2x.service.batch import BatchConverter, remove_lossless_originals


STATIC_DIR = Path(__file__).with_name("static")


class AppState:
    def __init__(self, root: Path, workers: int) -> None:
        self.lock = threading.RLock()
        self.cancel = threading.Event()
        self.root = root
        self.workers = workers
        self.files: list[dict[str, Any]] = []
        self.results: list[Any] = []
        self.running = False
        self.message = ""
        self.progress = ProgressTracker(0, 0).snapshot()

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            progress = self.progress
            return {
                "root": str(self.root),
                "workers": self.workers,
                "running": self.running,
                "message": self.message,
                "total": progress.total,
                "completed": progress.completed,
                "failed": progress.failed,
                "percent": round(progress.percent, 1),
                "elapsed_seconds": round(progress.elapsed_seconds, 1),
                "estimated_remaining_seconds": progress.estimated_remaining_seconds,
                "bytes_before": progress.bytes_before,
                "bytes_after": progress.bytes_after,
                "size_delta": progress.size_delta,
                "files": list(self.files),
            }


class AppServer(ThreadingHTTPServer):
    allow_reuse_address = True

    def __init__(self, host: str = "127.0.0.1", port: int = 8765, root: Path = Path.home(), workers: int = 2) -> None:
        self.app_state = AppState(root, workers)
        super().__init__((host, port), AppRequestHandler)


class AppRequestHandler(BaseHTTPRequestHandler):
    server: AppServer

    def log_message(self, format: str, *args: object) -> None:
        return

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/status":
            self._json(self.server.app_state.snapshot())
            return
        if path in {"/", "/index.html"}:
            self._file("index.html")
            return
        self._json({"error": "페이지를 찾을 수 없습니다"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            body = self._body()
            if path == "/api/scan":
                self._scan(body)
            elif path == "/api/start":
                self._start(body)
            elif path == "/api/delete-lossless":
                self._delete()
            else:
                self._json({"error": "API를 찾을 수 없습니다"}, HTTPStatus.NOT_FOUND)
        except (ValueError, OSError) as exc:
            self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            self._json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def _scan(self, body: dict[str, Any]) -> None:
        root = self._root(body)
        files = scan_hwp_files(ScanOptions(root=root))
        state = self.server.app_state
        with state.lock:
            state.root = root
            state.results = []
            state.running = False
            state.message = f"{len(files)}개 파일을 찾았습니다"
            state.progress = ProgressTracker(len(files), sum(item.size_bytes for item in files)).snapshot()
            state.files = [_file_row(item) for item in files]
        self._json(state.snapshot())

    def _start(self, body: dict[str, Any]) -> None:
        state = self.server.app_state
        with state.lock:
            if state.running:
                raise ValueError("이미 변환을 시작했습니다")
            if not state.files:
                raise ValueError("먼저 HWP 파일을 찾아주세요")
            workers = body.get("workers", state.workers)
            if not isinstance(workers, int) or workers < 1:
                raise ValueError("동시 작업 수는 1 이상이어야 합니다")
            state.workers = min(workers, max(1, os.cpu_count() or 1))
            files = [HwpFile(Path(item["path"]), int(item["size_bytes"])) for item in state.files]
            state.progress = ProgressTracker(len(files), sum(item.size_bytes for item in files)).snapshot()
            state.running = True
            state.cancel.clear()
            state.message = "변환을 시작했습니다"
        compare = bool(body.get("compare"))
        threading.Thread(target=self._convert, args=(files, compare), daemon=True).start()
        self._json({"started": True, **state.snapshot()}, HTTPStatus.ACCEPTED)

    def _convert(self, files: list[HwpFile], compare: bool) -> None:
        state = self.server.app_state
        comparator = RhwpComparator() if compare else None
        service = BatchConverter(HancomConverter(), comparator, state.workers)

        def progress(snapshot: ProgressSnapshot, result: Any) -> None:
            with state.lock:
                state.progress = snapshot
                for row in state.files:
                    if row["path"] == str(result.source):
                        row["status"] = _status_label(result.status.value)
                        row["message"] = result.message
                        row["target_size"] = result.target_size
                        row["lossless"] = result.lossless

        results = service.run(files, progress, state.cancel)
        with state.lock:
            state.results = results
            state.running = False
            state.message = "변환이 끝났습니다"

    def _delete(self) -> None:
        state = self.server.app_state
        with state.lock:
            deleted = remove_lossless_originals(state.results)
            deleted_paths = {str(path) for path in deleted}
            state.files = [row for row in state.files if row["path"] not in deleted_paths]
            state.message = f"무손실 원본 {len(deleted)}개를 삭제했습니다"
        self._json({"deleted": len(deleted), **state.snapshot()})

    def _root(self, body: dict[str, Any]) -> Path:
        raw = body.get("root")
        if not isinstance(raw, str) or not raw.strip():
            raise ValueError("검색 경로를 입력하세요")
        root = Path(raw).expanduser().resolve()
        if not root.is_dir():
            raise ValueError("존재하는 폴더 경로를 입력하세요")
        return root

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 1_048_576:
            raise ValueError("요청 본문이 너무 큽니다")
        value = json.loads(self.rfile.read(length).decode("utf-8") if length else "{}")
        if not isinstance(value, dict):
            raise ValueError("JSON 객체가 필요합니다")
        return value

    def _json(self, payload: dict[str, Any], status: int = HTTPStatus.OK) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def _file(self, name: str) -> None:
        path = (STATIC_DIR / name).resolve()
        if STATIC_DIR.resolve() not in path.parents or not path.is_file():
            self._json({"error": "파일을 찾을 수 없습니다"}, HTTPStatus.NOT_FOUND)
            return
        content = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{mimetypes.guess_type(path.name)[0] or 'text/html'}; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


def _file_row(item: HwpFile) -> dict[str, Any]:
    return {"name": item.source.name, "path": str(item.source), "size_bytes": item.size_bytes, "target_size": 0, "status": "대기", "message": "", "lossless": None}


def _status_label(value: str) -> str:
    return {"completed": "완료", "verified": "무손실", "failed": "실패", "skipped": "건너뜀", "converting": "변환 중"}.get(value, "대기")
