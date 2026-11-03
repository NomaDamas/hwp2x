from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Callable, Iterable

from hwp2x.core.models import HancomInstallation


RegistryReader = Callable[[], Iterable[tuple[str, str]]]
_VERSION = re.compile(r"(20\d{2}|\d+(?:\.\d+)*)")
_EXECUTABLES = ("Hwp.exe", "HwpApp.exe")


def discover_hancom(
    search_roots: Iterable[os.PathLike[str] | str] | None = None,
    registry_reader: RegistryReader | None = None,
    platform_name: str | None = None,
) -> list[HancomInstallation]:
    """설치된 한글 실행 파일을 찾아 최신 사용 가능 버전이 앞에 오게 반환한다."""
    system = platform_name or os.name
    roots = list(search_roots) if search_roots is not None else _default_roots(system)
    found: dict[Path, HancomInstallation] = {}
    for root in roots:
        base = Path(root).expanduser()
        if not base.is_dir():
            continue
        for executable in _EXECUTABLES:
            try:
                candidates = base.rglob(executable)
            except OSError:
                continue
            for path in candidates:
                try:
                    if path.is_file():
                        resolved = path.resolve()
                        found[resolved] = _installation(resolved)
                except OSError:
                    continue

    reader = registry_reader
    if reader is None and system == "nt":
        reader = _windows_registry_reader
    if reader is not None:
        try:
            entries = reader()
        except (OSError, ImportError, AttributeError, TypeError):
            entries = ()
        for entry in entries:
            parsed = _registry_entry(entry)
            if parsed is None:
                continue
            version, location = parsed
            path = Path(location).expanduser()
            try:
                if path.name in _EXECUTABLES and path.is_file():
                    resolved = path.resolve()
                    found[resolved] = _installation(resolved, version)
            except OSError:
                continue
    return sorted(found.values(), key=_sort_key, reverse=True)


def _windows_registry_reader() -> Iterable[tuple[str, str]]:
    """설치표에서 한글 실행 파일 경로를 읽는다(Windows에서만 호출)."""
    try:
        import winreg
    except ImportError:
        return ()
    entries: list[tuple[str, str]] = []
    roots = (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER)
    paths = (
        r"SOFTWARE\HNC\HOffice",
        r"SOFTWARE\WOW6432Node\HNC\HOffice",
    )
    for root in roots:
        for key_path in paths:
            try:
                with winreg.OpenKey(root, key_path) as key:
                    for index in range(winreg.QueryInfoKey(key)[0]):
                        try:
                            name = winreg.EnumKey(key, index)
                            with winreg.OpenKey(key, name) as version_key:
                                for value_name in ("InstallPath", "Path", "ExePath"):
                                    try:
                                        value, _ = winreg.QueryValueEx(version_key, value_name)
                                    except OSError:
                                        continue
                                    path = Path(str(value))
                                    if path.is_dir():
                                        for executable in _EXECUTABLES:
                                            candidate = path / executable
                                            if candidate.is_file():
                                                entries.append((name, str(candidate)))
                                    elif path.name in _EXECUTABLES:
                                        entries.append((name, str(path)))
                                    break
                        except OSError:
                            continue
            except OSError:
                continue
    return entries


def _registry_entry(entry: object) -> tuple[str | None, str] | None:
    if isinstance(entry, (tuple, list)) and len(entry) >= 2:
        first, second = str(entry[0]), str(entry[1])
        if Path(first).name in _EXECUTABLES:
            return second, first
        return first, second
    if isinstance(entry, (str, os.PathLike)):
        return None, os.fspath(entry)
    return None


def _default_roots(platform_name: str) -> list[Path]:
    if platform_name != "nt":
        return []
    roots = [Path(os.environ.get("ProgramFiles", r"C:\Program Files")), Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))]
    return [root / "HNC" for root in roots]


def _installation(path: Path, version: str | None = None) -> HancomInstallation:
    detected = version or _version_from_path(path)
    return HancomInstallation("한컴오피스 한글", detected or "unknown", path, True)


def _version_from_path(path: Path) -> str:
    for part in reversed(path.parts):
        match = _VERSION.search(part)
        if match:
            return match.group(1)
    return "unknown"


def _sort_key(item: HancomInstallation) -> tuple[int, tuple[int, ...]]:
    numbers = tuple(int(part) for part in re.findall(r"\d+", item.version))
    return (1 if item.available else 0, numbers)
