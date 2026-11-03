# -*- mode: python ; coding: utf-8 -*-

a = Analysis(
    ["hwp2x/__main__.py"],
    pathex=[],
    binaries=[],
    datas=[("hwp2x/ui/static", "hwp2x/ui/static")],
    hiddenimports=["webview"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="hwp2x",
    console=True,
)
coll = COLLECT(exe, a.binaries, a.datas, name="hwp2x")
