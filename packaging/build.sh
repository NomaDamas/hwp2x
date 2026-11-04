#!/bin/sh
set -eu

case "$(uname -s)" in
  Linux)
    uv run --with pyinstaller --with pywebview python -m PyInstaller --noconfirm --clean hwp2x.spec
    rm -rf packaging/payload packaging/payload.nsh
    mkdir -p packaging/payload
    cp -a dist/hwp2x/. packaging/payload/
    fpm_required=1
    ;;
  MINGW*|MSYS*|Windows*)
    command -v makensis >/dev/null 2>&1 || {
      printf '%s\n' 'makensis is required to build the Windows installer' >&2
      exit 1
    }
    python3 -m PyInstaller --noconfirm --clean hwp2x.spec
    rm -rf packaging/payload-win packaging/payload-win.nsh
    mkdir -p packaging/payload-win
    cp -a dist/hwp2x/. packaging/payload-win/
    find packaging/payload-win -type f -print | sort | sed 's|^packaging/|  File "|;s|$|"|' > packaging/payload-win.nsh
    (cd packaging && makensis hwp2x.nsi)
    mkdir -p dist
    mv -f packaging/hwp2x-setup.exe dist/hwp2x-setup.exe
    if [ -n "${HWP2X_SIGN_PFX:-}" ]; then
      command -v osslsigncode >/dev/null 2>&1 || {
        printf '%s\n' 'osslsigncode is required when HWP2X_SIGN_PFX is set' >&2
        exit 1
      }
      osslsigncode sign -pkcs12 "$HWP2X_SIGN_PFX" -pass "${HWP2X_SIGN_PASS:-}" \
        -n "hwp2x" -i "https://github.com/NomaDamas/hwp2x" -t "http://timestamp.digicert.com" \
        -in dist/hwp2x-setup.exe -out dist/hwp2x-setup.signed.exe
      mv -f dist/hwp2x-setup.signed.exe dist/hwp2x-setup.exe
    fi
    exit 0
    ;;
  *)
    printf 'Unsupported platform: %s\n' "$(uname -s)" >&2
    exit 1
    ;;
esac

if find packaging/payload -type f -print -quit | grep -q .; then
  find packaging/payload -type f -print | sort | sed 's|^packaging/|  File "|;s|$|"|' > packaging/payload.nsh
else
  printf '%s\n' '  File "packaging/NOTICE.txt"' > packaging/payload.nsh
fi

command -v fpm >/dev/null 2>&1 || {
  printf '%s\n' 'fpm is required to build the Debian package' >&2
  exit 1
}
fpm -s dir -t deb -n hwp2x -v 0.1.0 -p dist/hwp2x_0.1.0_amd64.deb \
  packaging/payload/=/opt/hwp2x \
  packaging/hwp2x.desktop=/usr/share/applications/hwp2x.desktop \
  THIRD_PARTY_NOTICES.md=/usr/share/doc/hwp2x/THIRD_PARTY_NOTICES.md
