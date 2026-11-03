from __future__ import annotations

import argparse
import json
import os
import webbrowser
from pathlib import Path

from hwp2x.ui.server import AppServer


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="로컬 HWP 파일을 HWPX로 일괄 변환합니다.")
    parser.add_argument("--root", type=Path, default=Path.home(), help="검색할 폴더")
    parser.add_argument("--host", default="127.0.0.1", help="로컬 화면 주소")
    parser.add_argument("--port", type=int, default=8765, help="로컬 화면 포트")
    parser.add_argument("--workers", type=int, default=None, help="동시 작업 수")
    parser.add_argument("--no-browser", action="store_true", help="브라우저를 자동으로 열지 않음")
    parser.add_argument("--scan-only", action="store_true", help="화면 없이 검색 결과만 출력")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.scan_only:
        from hwp2x.core.models import ScanOptions
        from hwp2x.core.scanner import scan_hwp_files

        files = scan_hwp_files(ScanOptions(root=args.root))
        print(json.dumps([{"path": str(item.source), "size": item.size_bytes} for item in files], ensure_ascii=False))
        return 0

    workers = args.workers or min(max(1, (os.cpu_count() or 2) // 2), 4)
    server = AppServer(host=args.host, port=args.port, root=args.root, workers=workers)
    url = f"http://{args.host}:{args.port}/"
    print(f"hwp2x 실행 중: {url}")
    if not args.no_browser:
        webbrowser.open(url)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
