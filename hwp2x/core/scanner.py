from __future__ import annotations

from pathlib import Path

from hwp2x.core.models import HwpFile, ScanOptions

_HWP_SUFFIX = ".hwp"


def scan_hwp_files(options: ScanOptions) -> list[HwpFile]:
    """Collect ``.hwp`` files under ``options.root``.

    Only the ``.hwp`` suffix is accepted, case-insensitively. Directory names
    listed in ``excluded_dirs`` are skipped wherever they appear. Results are
    sorted by source path. Symlinks and unreadable entries are ignored.
    """
    root = Path(options.root)
    if not root.is_dir():
        raise ValueError(f"scan root is not a directory: {root}")

    excluded = {name.casefold() for name in options.excluded_dirs}
    found: list[HwpFile] = []
    _walk(root, recursive=options.recursive, excluded=excluded, found=found)
    found.sort(key=lambda item: item.source)
    return found


def _walk(
    directory: Path,
    *,
    recursive: bool,
    excluded: set[str],
    found: list[HwpFile],
) -> None:
    try:
        entries = list(directory.iterdir())
    except OSError:
        return

    for entry in entries:
        try:
            is_dir = entry.is_dir()
            is_file = entry.is_file()
        except OSError:
            continue
        if entry.is_symlink():
            continue
        if is_dir:
            if not recursive or entry.name.casefold() in excluded:
                continue
            _walk(entry, recursive=True, excluded=excluded, found=found)
            continue
        if is_file and entry.suffix.casefold() == _HWP_SUFFIX:
            try:
                size = entry.stat().st_size
            except OSError:
                continue
            found.append(HwpFile(source=entry, size_bytes=size))
