"""Hancom HWP to HWPX conversion through the Windows COM API."""

from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any

from hwp2x.core.errors import ConversionError, ConverterUnavailable


class HancomConverter:
    """Convert HWP documents with an isolated Hancom COM instance."""

    def convert(self, source: str | os.PathLike[str], target: str | os.PathLike[str]) -> None:
        """Convert *source* to *target*, raising a domain error on failure."""
        if os.name != "nt":
            raise ConverterUnavailable("이 컴퓨터는 Windows가 아니거나 한글 프로그램 연동을 사용할 수 없습니다")

        try:
            import pythoncom  # type: ignore[import-not-found]
            import win32com.client  # type: ignore[import-not-found]
        except Exception as exc:
            raise ConverterUnavailable(
                "Hancom COM conversion requires the pywin32 package"
            ) from exc

        source_path = Path(source)
        target_path = Path(target)
        result: list[BaseException] = []

        def run() -> None:
            hwp: Any = None
            initialized = False
            try:
                pythoncom.CoInitialize()
                initialized = True
                hwp = win32com.client.DispatchEx("HWPFrame.HwpObject")
                hwp.Open(str(source_path), "HWP", "")
                hwp.SaveAs(str(target_path), "HWPX", "")
            except BaseException as exc:  # translate every COM/thread failure below
                result.append(exc)
            finally:
                if hwp is not None:
                    try:
                        hwp.Quit()
                    except BaseException as exc:
                        if not result:
                            result.append(exc)
                if initialized:
                    try:
                        pythoncom.CoUninitialize()
                    except BaseException as exc:
                        if not result:
                            result.append(exc)

        worker = threading.Thread(target=run, name="hwp2x-com-worker")
        worker.start()
        worker.join()

        if result:
            raise ConversionError(
                f"Failed to convert {source_path} to {target_path}: {result[0]}"
            ) from result[0]
        if not target_path.is_file():
            raise ConversionError(
                f"Hancom conversion completed without creating target: {target_path}"
            )


def convert(source: str | os.PathLike[str], target: str | os.PathLike[str]) -> None:
    """Convenience wrapper around :class:`HancomConverter`."""
    HancomConverter().convert(source, target)
