#!/bin/sh
set -eu
python3 -m PyInstaller --noconfirm --clean hwp2x.spec

rm -rf packaging/payload packaging/payload.nsh
mkdir -p packaging/payload
cp -a dist/hwp2x/. packaging/payload/

if find packaging/payload -type f -print -quit | grep -q .; then
  find packaging/payload -type f -print | sort | sed 's|^|  File "|;s|$|"|' > packaging/payload.nsh
else
  printf '%s\n' '  File "packaging/NOTICE.txt"' > packaging/payload.nsh
fi

case "$(uname -s)" in
  Linux)
    command -v fpm >/dev/null 2>&1 || {
      printf '%s\n' 'fpm is required to build the Debian package' >&2
      exit 1
    }
    fpm -s dir -t deb -n hwp2x -v 0.1.0 \
      packaging/payload/=/opt/hwp2x \
      packaging/hwp2x.desktop=/usr/share/applications/hwp2x.desktop \
      THIRD_PARTY_NOTICES.md=/usr/share/doc/hwp2x/THIRD_PARTY_NOTICES.md
    ;;
  MINGW*|MSYS*|Windows*)
    command -v makensis >/dev/null 2>&1 || {
      printf '%s\n' 'makensis is required to build the Windows installer' >&2
      exit 1
    }
    makensis packaging/hwp2x.nsi
    ;;
  *)
    printf 'Unsupported platform: %s\n' "$(uname -s)" >&2
    exit 1
    ;;
esac
