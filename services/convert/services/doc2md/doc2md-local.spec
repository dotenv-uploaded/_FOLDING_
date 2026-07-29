from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata


PROJECT = Path(SPEC).resolve().parent
datas = []
hiddenimports = []

for package in (
    "app",
    "magika",
    "markitdown",
    "pyhwp2md",
    "uvicorn",
):
    datas += collect_data_files(package)
    hiddenimports += collect_submodules(package)

for distribution in (
    "markitdown",
    "pyhwp2md",
    "python-multipart",
):
    datas += copy_metadata(distribution)

analysis = Analysis(
    [str(PROJECT / "app" / "cli.py")],
    pathex=[str(PROJECT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "paddle",
        "paddleocr",
        "paddlex",
        "PIL",
    ],
    noarchive=False,
    optimize=0,
)
python_zip = PYZ(analysis.pure)
executable = EXE(
    python_zip,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="doc2md-local",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)
bundle = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="doc2md-local",
)
