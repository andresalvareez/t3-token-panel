#!/usr/bin/env python3
"""Rebuild the patch from an original T3 Beta 0.1.11 archive without modifying the app."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
CLIENT = "apps/server/dist/client/assets/_chat-CpVn0Bm5.js"
SERVER = "apps/server/dist/server-8K5Ixyrs.mjs"


def local_module(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if sys.version_info < (3, 9):
        raise ValueError("Python 3.9 or newer is required")
    installer = local_module("install")
    asar = local_module("asar_repack")
    current = installer.check()
    source = installer.ASAR if current == installer.BASE_HASH else installer.ORIGINAL
    if not source.is_file() or installer.sha256(source) != installer.BASE_HASH:
        raise ValueError("A compatible original app.asar backup is required")
    target = installer.PATCHED
    if target.exists():
        if installer.sha256(target) == installer.PATCH_HASH:
            print("The patch has already been prepared and verified")
            return
        raise ValueError("An output with a different SHA-256 already exists: " + str(target))
    node = shutil.which("node")
    if not node:
        raise ValueError("Install Node.js 18 or newer and run this command again")
    version = subprocess.check_output([node, "--version"], text=True).strip()
    if int(version.lstrip("v").split(".")[0]) < 18:
        raise ValueError("Node.js 18 or newer is required")

    with tempfile.TemporaryDirectory(prefix=".token-panel-build-", dir=HERE) as folder:
        work = Path(folder)
        inputs = work / "inputs"
        patched = work / "patched"
        inputs.mkdir()
        info = asar.read_header(source)
        with source.open("rb") as archive:
            for entry_path in (CLIENT, SERVER):
                entry = asar.find_entry(info["header"], entry_path)
                if not asar.is_packed(entry):
                    raise ValueError("Unexpected ASAR entry: " + entry_path)
                data = b"".join(asar.read_chunks(
                    archive, info["data_start"] + int(entry["offset"]), entry["size"]))
                (inputs / Path(entry_path).name).write_bytes(data)
        subprocess.run([
            node, str(HERE / "build.mjs"),
            str(inputs / Path(CLIENT).name), str(inputs / Path(SERVER).name),
            str(patched),
        ], check=True)
        replacements = {p: patched / Path(p).name for p in (CLIENT, SERVER)}
        candidate = work / "app.token-panel-0.1.11.asar"
        asar.repack(source, candidate, replacements)
        report = asar.verify(source, candidate, replacements)
        if report["newSha256"] != installer.PATCH_HASH:
            raise ValueError("The rebuild does not match the verified patch")
        os.replace(candidate, target)
        print(json.dumps(report, indent=2))
    print("Prepared. T3 was not modified. Quit T3, then run: python3 -I patch/install.py apply")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        sys.exit("Token panel: " + str(error))
