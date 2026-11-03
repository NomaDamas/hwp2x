from __future__ import annotations

import json
import mimetypes
import os
import shutil
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

from hwp2x.adapters.com_hwp import HancomConverter
from hwp2x.adapters.rhwp_compare import RhwpComparator
from hwp2x.core.models import HwpFile, ScanOptions
from hwp2x.core.scanner import scan_hwp_files
from hwp2x.service.batch import BatchConverter


STATIC_DIR = Path(__file__).with_name("static")
EXCLUDED = {"$recycle.bin", "system volume information", "windows", "program files", "program files (x86)", "hwp2x_백업"}
CHECK_LABELS = ("문단 텍스트", "표", "그림·개체", "글자·문단 모양", "머리말·꼬리말·각주")


class AppState:
    def __init__(self, root: Path, workers: int) -> None:
        self.lock = threading.RLock()
        self.cancel = threading.Event()
        self.root = root
        self.workers = workers
        self.phase = "idle"
        self.started = 0.0
        self.files: list[dict[str, Any]] = []
        self.results: list[Any] = []
        self.message = "준비됨"
        self.hancom_available = os.name == "nt"
        self.hancom_name = "한컴오피스 한글" if self.hancom_available else "감지되지 않음"
        self.installations: list[dict[str, str]] = []
        self.auto_backup = False
        self.backup_dir = Path.home() / "hwp2x_백업"
        self.skip_existing = True
        self.excluded = set(EXCLUDED)
        self.converter_factory: Callable[[], Any] = HancomConverter
        self.comparator_factory: Callable[[], Any] = RhwpComparator
        self._refresh_hancom()

    def _refresh_hancom(self) -> None:
        discover = getattr(self.converter_factory, "discover", None)
        if not callable(discover):
            try:
                from hwp2x.adapters.hancom_discovery import discover_hancom
                discover = discover_hancom
            except Exception:
                discover = None
        found = []
        if callable(discover):
            try:
                found = list(discover())
            except Exception:
                found = []
        self.installations = [
            {"name": item.name, "version": item.version, "path": str(item.executable), "available": bool(item.available)}
            for item in found
        ]
        if found:
            chosen = found[0]
            self.hancom_available = bool(chosen.available)
            self.hancom_name = f"{chosen.name} {chosen.version}".strip()
        elif os.name != "nt":
            self.hancom_available = False
            self.hancom_name = "감지되지 않음"

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            done = [item for item in self.files if item["status"] not in {"wait", "conv"}]
            counts = {key: sum(item["status"] == key for item in self.files) for key in ("ok", "diff", "fail", "deleted", "wait", "conv", "skipped")}
            elapsed = time.monotonic() - self.started if self.started else 0.0
            rate = len(done) / elapsed if elapsed and done else 0.0
            total = len(self.files)
            successful = [item for item in done if item["status"] not in {"fail", "skipped"}]
            target_bytes = sum(item["targetSize"] for item in successful)
            done_source = sum(item["size"] for item in successful)
            issues = [item for item in self.files if item["status"] in {"fail", "diff"}]
            return {
                "phase": self.phase, "message": self.message, "root": str(self.root), "workers": self.workers,
                "hancomAvailable": self.hancom_available, "hancomName": self.hancom_name, "installations": list(self.installations),
                "autoBackup": self.auto_backup, "backupDir": str(self.backup_dir), "skipExisting": self.skip_existing,
                "excluded": sorted(self.excluded), "total": total, "completed": len(done),
                "percent": 0 if not total else round(len(done) / total * 100, 1),
                "counts": counts, "elapsed": elapsed, "remaining": (total - len(done)) / rate if rate else None,
                "bytesBefore": sum(item["size"] for item in self.files), "bytesAfter": target_bytes,
                "sizeDelta": target_bytes - done_source, "files": list(self.files), "issues": list(issues),
            }


class AppServer(ThreadingHTTPServer):
    allow_reuse_address = True

    def __init__(self, host: str = "127.0.0.1", port: int = 8765, root: Path = Path.home(), workers: int = 2) -> None:
        self.state = AppState(root, workers)
        super().__init__((host, port), AppRequestHandler)


class AppRequestHandler(BaseHTTPRequestHandler):
    server: AppServer

    def log_message(self, format: str, *args: object) -> None:
        return

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/state":
            self._json(self.server.state.snapshot())
        elif path in {"/", "/index.html"}:
            self._redirect("/app.html")
        else:
            self._file(path.lstrip("/"))

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        routes = {
            "/api/scan": self._scan, "/api/start": self._start, "/api/pause": self._pause,
            "/api/backup-delete": self._backup_delete, "/api/settings": self._settings,
            "/api/detect": self._detect, "/api/retry": self._retry,
        }
        try:
            if path not in routes:
                self._json({"error": "API를 찾을 수 없습니다"}, HTTPStatus.NOT_FOUND)
            else:
                routes[path](self._body())
        except Exception as exc:
            self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def _scan(self, body: dict[str, Any]) -> None:
        state = self.server.state
        root = _directory(body.get("root"), state.root)
        files = scan_hwp_files(ScanOptions(root=root, excluded_dirs=set(state.excluded)))
        with state.lock:
            state.root, state.phase, state.results = root, "ready", []
            state.files = [_row(item) for item in files]
            state.message = f"{len(files)}개 파일을 찾았습니다"
        self._json(state.snapshot())

    def _start(self, body: dict[str, Any]) -> None:
        state = self.server.state
        with state.lock:
            if state.phase == "converting":
                raise ValueError("이미 변환 중입니다")
            workers = body.get("workers", state.workers)
            if not isinstance(workers, int) or not 1 <= workers <= 8:
                raise ValueError("동시 작업 수는 1~8이어야 합니다")
            state.workers = workers
            state.auto_backup = bool(body.get("autoBackup", state.auto_backup))
            if not state.files:
                state.files = [_row(item) for item in scan_hwp_files(ScanOptions(root=state.root, excluded_dirs=set(state.excluded)))]
            selected = [item for item in state.files if item["status"] in {"wait", "fail"}]
            for item in selected:
                item["status"] = "conv"
            state.phase, state.started, state.message = "converting", time.monotonic(), "변환 및 검증 중"
            state.cancel.clear()
        threading.Thread(target=self._convert, args=(selected, bool(body.get("compare", True))), daemon=True).start()
        self._json(state.snapshot(), HTTPStatus.ACCEPTED)

    def _convert(self, selected: list[dict[str, Any]], compare: bool) -> None:
        state = self.server.state
        comparator = state.comparator_factory() if compare else None
        service = BatchConverter(state.converter_factory(), comparator, state.workers)
        items = [HwpFile(Path(item["path"]), item["size"]) for item in selected]

        def progress(_snapshot: object, result: Any) -> None:
            with state.lock:
                if comparator is not None and result.target and result.target.is_file() and result.status.value != "failed":
                    try:
                        comparison = comparator.compare(result.source, result.target)
                        result.details = tuple(getattr(comparison, "details", ()) or ())
                    except Exception:
                        result.details = ()
                state.results.append(result)
                for row in state.files:
                    if row["path"] == str(result.source):
                        row.update(_result_row(result))
                if state.auto_backup and result.lossless is True and result.source.is_file():
                    _move_original(result, state.backup_dir)
                    for row in state.files:
                        if row["path"] == str(result.source):
                            row["status"] = "deleted"

        service.run(items, progress, state.cancel)
        with state.lock:
            for index, item in enumerate(items):
                for row in state.files:
                    if row["path"] == str(item.source) and row["status"] == "conv":
                        row["status"], row["message"] = "wait", "중지되어 대기 중입니다"
            state.phase = "paused" if state.cancel.is_set() else "done"
            state.message = "아직 시작하지 않은 변환을 중지했습니다" if state.cancel.is_set() else "변환이 끝났습니다"

    def _pause(self, _body: dict[str, Any]) -> None:
        state = self.server.state
        state.cancel.set()
        with state.lock:
            state.phase, state.message = "paused", "아직 시작하지 않은 변환을 중지했습니다"
        self._json(state.snapshot())

    def _backup_delete(self, body: dict[str, Any]) -> None:
        if body.get("consent") is not True:
            raise ValueError("검증 결과 확인 동의가 필요합니다")
        state = self.server.state
        moved = []
        with state.lock:
            destination = _directory(body.get("backupDir"), state.backup_dir)
            for result in list(state.results):
                if result.lossless is True and result.source.is_file() and result.target and result.target.is_file():
                    moved.append(str(_move_original(result, destination)))
                    for row in state.files:
                        if row["path"] == str(result.source):
                            row["status"], row["message"] = "deleted", "백업 후 기존 위치에서 삭제됨"
            state.backup_dir = destination
            state.message = f"무손실 원본 {len(moved)}개를 백업 후 삭제했습니다"
        self._json({"moved": moved, **state.snapshot()})

    def _settings(self, body: dict[str, Any]) -> None:
        state = self.server.state
        with state.lock:
            if "workers" in body:
                if not isinstance(body["workers"], int) or not 1 <= body["workers"] <= 8:
                    raise ValueError("동시 작업 수는 1~8이어야 합니다")
                state.workers = body["workers"]
            if "autoBackup" in body:
                state.auto_backup = bool(body["autoBackup"])
            if "skipExisting" in body:
                state.skip_existing = bool(body["skipExisting"])
            if "backupDir" in body:
                state.backup_dir = _directory(body["backupDir"], state.backup_dir)
            if "root" in body:
                state.root = _directory(body["root"], state.root)
            if isinstance(body.get("excluded"), list):
                state.excluded = {str(item).casefold() for item in body["excluded"] if str(item).strip()}
            state.message = "설정을 저장했습니다"
        self._json(state.snapshot())

    def _detect(self, _body: dict[str, Any]) -> None:
        state = self.server.state
        with state.lock:
            state._refresh_hancom()
            state.message = "한글 설치를 다시 확인했습니다" if state.hancom_available else "이 PC에서 한컴오피스 한글을 찾지 못했습니다"
        self._json(state.snapshot())

    def _retry(self, body: dict[str, Any]) -> None:
        state = self.server.state
        path = body.get("path")
        with state.lock:
            selected = [item for item in state.files if item["path"] == path and item["status"] in {"fail", "diff"}]
            if not selected:
                raise ValueError("다시 시도할 파일을 찾지 못했습니다")
            for item in selected:
                item["status"] = "conv"
            state.phase, state.started, state.message = "converting", time.monotonic(), "선택한 파일을 다시 시도합니다"
            state.cancel.clear()
        threading.Thread(target=self._convert, args=(selected, bool(body.get("compare", True))), daemon=True).start()
        self._json(state.snapshot(), HTTPStatus.ACCEPTED)

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 1_048_576:
            raise ValueError("요청 본문이 너무 큽니다")
        value = json.loads(self.rfile.read(length).decode("utf-8") if length else "{}")
        if not isinstance(value, dict):
            raise ValueError("JSON 객체가 필요합니다")
        return value

    def _json(self, payload: dict[str, Any], status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        for key, value in {"Content-Type": "application/json; charset=utf-8", "Content-Length": str(len(body)), "Cache-Control": "no-store"}.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _redirect(self, location: str) -> None:
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", location)
        self.end_headers()

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


def _directory(value: object, fallback: Path) -> Path:
    if not isinstance(value, str) or not value.strip():
        return fallback
    path = Path(value).expanduser()
    if path.exists() and not path.is_dir():
        raise ValueError("폴더 경로를 입력하세요")
    return path


def _row(item: HwpFile) -> dict[str, Any]:
    return {"name": item.source.name, "path": str(item.source), "dir": str(item.source.parent), "size": item.size_bytes, "targetSize": 0, "status": "wait", "message": "", "lossless": None, "checks": []}


def _result_row(result: Any) -> dict[str, Any]:
    if result.status.value == "failed":
        status = "fail"
    elif result.status.value == "skipped":
        status = "skipped"
    elif result.lossless is True:
        status = "ok"
    elif result.lossless is False:
        status = "diff"
    else:
        status = "ok"
    checks = []
    details = tuple(getattr(result, "details", ()) or ())
    if result.lossless is not None:
        checks = [{"label": label, "value": "일치" if result.lossless and not details else "차이", "ok": bool(result.lossless) and not details} for label in CHECK_LABELS]
        if details:
            checks[0] = {"label": CHECK_LABELS[0], "value": details[0], "ok": False}
    return {"status": status, "targetSize": result.target_size, "message": result.message, "lossless": result.lossless, "checks": checks}


def _move_original(result: Any, destination: Path) -> Path:
    destination.mkdir(parents=True, exist_ok=True)
    source = result.source.resolve()
    name = "__".join(source.parts[1:]) if source.is_absolute() else source.name
    target = destination / name
    stem, suffix, number = target.stem, target.suffix, 1
    while target.exists():
        target = destination / f"{stem} ({number}){suffix}"
        number += 1
    shutil.move(str(source), target)
    return target
