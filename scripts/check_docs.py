import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
readme = (root / "README.md").read_text(encoding="utf-8")
missing = []
for document in (root / "README.md", root / "docs" / "manual.md"):
    text = document.read_text(encoding="utf-8")
    if not re.search(r"^#\s+\S", text, re.MULTILINE):
        missing.append(f"{document.name}: 제목 없음")
    for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)|!\[[^\]]*\]\(([^)]+)\)", text):
        link = next(item for item in target if item)
        if link.startswith(("http://", "https://")):
            continue
        if not (document.parent / link).exists():
            missing.append(f"{document.relative_to(root)} -> {link}")
for item in ("hwp2x-setup.exe", "hwp2x_0.1.0_amd64.deb", "Windows 10", "한글 2014"):
    if item not in readme:
        missing.append(item)
if missing:
    print("\n".join(missing))
    sys.exit(1)
print("docs-ok")
