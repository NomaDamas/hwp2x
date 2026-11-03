"""한컴오피스 한글의 Windows COM 자동화로 HWP를 HWPX로 저장한다."""

from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any, Callable

from hwp2x.adapters.hancom_discovery import discover_hancom
from hwp2x.core.errors import ConversionError, ConverterUnavailable
from hwp2x.core.models import HancomInstallation


class HancomConverter:
    """탐지된 한글 중 최신 버전으로 변환한다."""

    def __init__(
        self,
        discovery: Callable[[], list[HancomInstallation]] | None = None,
        dispatcher: Callable[[], Any] | None = None,
        platform_name: str | None = None,
    ) -> None:
        self.discovery = discovery or discover_hancom
        self.dispatcher = dispatcher
        self.platform_name = platform_name or os.name

    def discover(self) -> list[HancomInstallation]:
        return self.discovery()

    def convert(self, source: str | os.PathLike[str], target: str | os.PathLike[str]) -> None:
        source_path, target_path = Path(source), Path(target)
        if target_path.exists():
            raise ConversionError(f"같은 이름의 HWPX 파일이 이미 있어 덮어쓰지 않습니다: {target_path}")

        installations = [item for item in self.discover() if item.available]
        if not installations:
            raise ConverterUnavailable("이 PC에서 한컴오피스 한글을 찾지 못했습니다. 한글 2022, 2020, 2018, 2014 중 하나를 설치한 뒤 다시 감지하세요.")

        chosen = installations[0]
        if self.platform_name != "nt" and self.dispatcher is None:
            raise ConverterUnavailable(
                f"'{chosen.name}' ({chosen.version})을 찾았지만, 이 컴퓨터는 Windows가 아니어서 한글 COM 자동화를 사용할 수 없습니다."
            )

        self._convert(source_path, target_path, chosen)

    def _convert(self, source: Path, target: Path, chosen: HancomInstallation) -> None:
        if self.dispatcher is not None:
            hwp = self.dispatcher()
            hwp.Open(str(source), "HWP", "")
            hwp.SaveAs(str(target), "HWPX", "")
            hwp.Quit()
            if not target.is_file():
                raise ConversionError(f"'{chosen.name}' ({chosen.version}) 변환 후 HWPX 파일을 생성하지 못했습니다: {target}")
            return

        try:
            import pythoncom
            import win32com.client
        except ImportError as exc:
            raise ConverterUnavailable(
                f"'{chosen.name}' ({chosen.version}) 변환을 위해 pywin32를 설치해야 합니다."
            ) from exc

        result: list[BaseException] = []

        def run() -> None:
            hwp: Any = None
            try:
                pythoncom.CoInitialize()
                hwp = win32com.client.DispatchEx("HWPFrame.HwpObject")
                hwp.Open(str(source), "HWP", "")
                hwp.SaveAs(str(target), "HWPX", "")
            except BaseException as exc:
                result.append(exc)
            finally:
                if hwp is not None:
                    hwp.Quit()
                pythoncom.CoUninitialize()

        worker = threading.Thread(target=run, name="hwp2x-com-worker")
        worker.start()
        worker.join()
        if result:
            raise ConversionError(
                f"'{chosen.name}' ({chosen.version})을 사용하여 '{source}'를 변환하는 중 오류가 발생했습니다: {result[0]}"
            ) from result[0]
        if not target.is_file():
            raise ConversionError(f"'{chosen.name}' ({chosen.version}) 변환 후 HWPX 파일을 생성하지 못했습니다: {target}")


def convert(source: str | os.PathLike[str], target: str | os.PathLike[str]) -> None:
    HancomConverter().convert(source, target)
