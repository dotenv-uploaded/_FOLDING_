from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata


PROJECT = Path(SPEC).resolve().parent
datas = []
hiddenimports = []

for package in (
    "claude_agent_sdk",
    "discord",
    "uvicorn",
    "pydantic_settings",
):
    datas += collect_data_files(package)
    hiddenimports += collect_submodules(package)

for distribution in (
    "claude-agent-sdk",
    "discord.py",
    "PyJWT",
    "python-dotenv",
):
    datas += copy_metadata(distribution)

analysis = Analysis(
    [str(PROJECT / "src" / "codegate_api" / "cli.py")],
    pathex=[str(PROJECT / "src")],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
python_zip = PYZ(analysis.pure)
executable = EXE(
    python_zip,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="codegate-local",
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
    name="codegate-local",
)
