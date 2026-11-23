#!/usr/bin/env python3
"""Install or restore the verified Panel de tokens build for T3 Beta 0.1.11."""
import argparse
import fcntl
import hashlib
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile

APP = Path("/Applications/T3 Code (Beta).app")
ASAR = APP / "Contents/Resources/app.asar"
PLIST = APP / "Contents/Info.plist"
PATCHED = Path(__file__).resolve().with_name("app.token-panel-0.1.11.asar")
BASE_HASH = "a505328c7a183f98103867e06ab46a93dd7f8739bc2990b6a73cd93fafd37959"
PATCH_HASH = "4daebdcd79c36607b5cae58070083fed1a7aefe0c8f0fbd4ca4912058835f41c"
PLIST_HASH = "626490c9fe69dcea1e67b21cab7ee3fd6564bb4da4793e270906ccfcc0a938b2"
BACKUPS = Path.home() / ".t3/userdata/backups/token-panel-0.1.11"
ORIGINAL = BACKUPS / "app.original.asar"
FUSE_MARKER = b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def t3_running():
    lines = subprocess.check_output(["ps", "-axo", "comm="], text=True).splitlines()
    return any(line.strip().startswith(f"{APP}/Contents/") for line in lines)


def check():
    version = plistlib.loads(PLIST.read_bytes())["CFBundleShortVersionString"]
    if version != "0.1.11" or sha256(PLIST) != PLIST_HASH:
        raise ValueError(f"T3 {version} is not the verified build for this patch")
    current = sha256(ASAR)
    if current not in (BASE_HASH, PATCH_HASH):
        raise ValueError(f"Unknown app.asar SHA-256 {current}")
    framework = APP / "Contents/Frameworks/Electron Framework.framework/Electron Framework"
    binary = framework.read_bytes()
    if binary.count(FUSE_MARKER) != 1:
        raise ValueError("Cannot verify Electron's ASAR integrity fuse")
    start = binary.index(FUSE_MARKER) + len(FUSE_MARKER)
    if binary[start : start + 2] != b"\x01\x09" or binary[start + 6] != ord("0"):
        raise ValueError("Electron's embedded ASAR integrity validation must be disabled by the installed build")
    return current


def replace_verified(src, dst, digest, check_before_commit=None):
    with tempfile.NamedTemporaryFile(dir=dst.parent, prefix=".token-panel-", delete=False) as file:
        staged = Path(file.name)
    try:
        if sha256(src) != digest:
            raise ValueError(f"Unexpected SHA-256 for {src}")
        shutil.copy2(src, staged)
        with staged.open("rb") as file:
            os.fsync(file.fileno())
        if sha256(staged) != digest:
            raise ValueError(f"Staged copy failed verification for {dst}")
        if check_before_commit is not None:
            check_before_commit()
        os.replace(staged, dst)
        if sha256(dst) != digest:
            raise ValueError(f"Destination failed verification for {dst}")
    finally:
        staged.unlink(missing_ok=True)


def install(command):
    current = check()
    if command == "check":
        print(f"T3 Beta 0.1.11: {'panel installed' if current == PATCH_HASH else 'compatible original build'}")
        return
    if (command == "apply" and current == PATCH_HASH) or (command == "restore" and current == BASE_HASH):
        print("Requested version is already installed")
        return
    if t3_running():
        raise ValueError("Quit T3 Code (Beta) completely before changing its archive")
    BACKUPS.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (BACKUPS / ".install.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if command == "apply":
            if not ORIGINAL.exists():
                replace_verified(ASAR, ORIGINAL, BASE_HASH)
            elif sha256(ORIGINAL) != BASE_HASH:
                raise ValueError(f"Invalid existing backup: {ORIGINAL}")
            source, expected = PATCHED, PATCH_HASH
        else:
            source, expected = ORIGINAL, BASE_HASH

        def verify_live_state():
            if t3_running() or sha256(ASAR) != current or sha256(PLIST) != PLIST_HASH:
                raise ValueError("T3 started or changed during staging")

        replace_verified(source, ASAR, expected, verify_live_state)
        print(f"{command}: verified {expected}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check", "apply", "restore"])
    args = parser.parse_args()
    try:
        install(args.command)
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f"Panel de tokens: {error}\n")
