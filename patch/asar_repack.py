#!/usr/bin/env python3
"""Size-changing ASAR repack (stdlib only). Run with: python3 -I asar_repack.py

Replaces the contents of packed files inside an asar, recomputes all offsets
after them and the integrity object of the replaced files exactly like
@electron/asar (SHA256, whole-file hash, 4 MiB blocks), and writes a NEW asar.
"unpacked", "link" and "executable" entries are left untouched. Never writes
inside an *.app bundle and never overwrites an existing file.

Subcommands:
  repack  --src OLD --dst NEW --replace asar/path=local/file [--replace ...]
  verify  --old OLD --new NEW --replace asar/path=local/file [...]
  info    ASAR
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import struct
import sys

if not __debug__:
    raise RuntimeError('Run without Python -O: integrity guards must stay enabled')

BLOCK_SIZE = 4 * 1024 * 1024
CHUNK = 1024 * 1024


class AsarError(Exception):
    pass


def require(cond, msg):
    if not cond:
        raise AsarError(msg)


def align4(n):
    return (n + 3) & ~3


# ---------------------------------------------------------------- header I/O

def read_header(path):
    """Return dict(header, raw, data_start, size). Validates pickle framing."""
    path = Path(path)
    size = path.stat().st_size
    with path.open('rb') as fh:
        pre = fh.read(16)
        require(len(pre) == 16, 'File too short for an asar preamble')
        marker, header_size, pickle_size, json_size = struct.unpack('<4I', pre)
        require(marker == 4, 'Bad size-pickle payload length (expected 4)')
        require(header_size == pickle_size + 4, 'Inconsistent header pickle sizes')
        require(pickle_size == 4 + align4(json_size), 'Header pickle size does not match aligned JSON length')
        data_start = 8 + header_size
        require(16 + json_size <= data_start <= size, 'Header exceeds file')
        raw = fh.read(json_size)
        require(len(raw) == json_size, 'Truncated header')
        pad = fh.read(data_start - 16 - json_size)
        require(pad == b'\0' * len(pad), 'Non-zero header padding')
    header = json.loads(raw)
    return dict(header=header, raw=raw, data_start=data_start, size=size)


def serialize_header(header):
    """Return the full preamble + JSON + padding (everything before file data)."""
    raw = json.dumps(header, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    padded = align4(len(raw))
    pickle_size = 4 + padded
    out = struct.pack('<4I', 4, pickle_size + 4, pickle_size, len(raw)) + raw
    return out + b'\0' * (padded - len(raw))


def walk(header):
    """Yield (path, entry) for every non-directory entry, in header order."""
    def rec(prefix, node):
        for name, child in node['files'].items():
            p = f'{prefix}/{name}' if prefix else name
            if 'files' in child:
                yield from rec(p, child)
            else:
                yield p, child
    yield from rec('', header)


def find_entry(header, path):
    node = header
    for part in path.split('/'):
        require('files' in node and part in node['files'], f'Path not in asar: {path}')
        node = node['files'][part]
    require('files' not in node, f'Path is a directory: {path}')
    return node


def is_packed(entry):
    return 'offset' in entry and not entry.get('unpacked') and not entry.get('link')


# ----------------------------------------------------------------- integrity

def integrity_of(chunks):
    """Mimic @electron/asar getFileIntegrity over an iterable of byte chunks.

    Quirk kept on purpose: the final (possibly empty) block is always hashed, so
    a file whose size is an exact multiple of 4 MiB gets a trailing empty-block hash.
    """
    whole = hashlib.sha256()
    blocks = []
    cur = hashlib.sha256()
    cur_len = 0
    for chunk in chunks:
        whole.update(chunk)
        view = memoryview(chunk)
        while len(view):
            take = min(BLOCK_SIZE - cur_len, len(view))
            cur.update(view[:take])
            cur_len += take
            view = view[take:]
            if cur_len == BLOCK_SIZE:
                blocks.append(cur.hexdigest())
                cur = hashlib.sha256()
                cur_len = 0
    blocks.append(cur.hexdigest())
    return {'algorithm': 'SHA256', 'hash': whole.hexdigest(), 'blockSize': BLOCK_SIZE, 'blocks': blocks}


def read_chunks(fh, offset, size):
    fh.seek(offset)
    left = size
    while left:
        data = fh.read(min(CHUNK, left))
        require(data, 'Unexpected EOF while reading asar payload')
        left -= len(data)
        yield data


def entry_integrity_from_file(fh, data_start, entry):
    return integrity_of(read_chunks(fh, data_start + int(entry['offset']), entry['size']))


# -------------------------------------------------------------------- repack

def check_output_path(dst, src=None):
    dst = Path(dst).absolute()
    resolved = Path(os.path.realpath(dst.parent)) / dst.name
    for part in resolved.parts:
        require(not part.endswith('.app'), f'Refusing to write inside an .app bundle: {dst}')
    require(not dst.exists() and not dst.is_symlink(), f'Refusing to overwrite existing file: {dst}')
    if src is not None:
        require(Path(os.path.realpath(src)) != resolved, 'Output must differ from source')
    return dst


def packed_layout(info):
    """Return packed entries sorted by offset, validating they are contiguous."""
    items = [(p, e) for p, e in walk(info['header']) if is_packed(e)]
    items.sort(key=lambda it: int(it[1]['offset']))
    pos = 0
    for p, e in items:
        require(int(e['offset']) == pos, f'Non-contiguous layout at {p}: expected offset {pos}')
        require(isinstance(e['size'], int) and e['size'] >= 0, f'Bad size for {p}')
        pos += e['size']
    require(info['data_start'] + pos == info['size'], 'Data region does not match file size (trailing/missing bytes)')
    return items


def load_replacements(spec):
    """spec: {asar_path: bytes | path-like}. Returns {asar_path: bytes}."""
    out = {}
    for key, val in spec.items():
        key = key.strip('/')
        out[key] = bytes(val) if isinstance(val, (bytes, bytearray)) else Path(val).read_bytes()
    return out


def repack(src, dst, replacements):
    src = Path(src)
    repl = load_replacements(replacements)
    require(repl, 'No replacements given')
    dst = check_output_path(dst, src)
    info = read_header(src)
    header = info['header']
    items = packed_layout(info)
    for path in repl:
        entry = find_entry(header, path)
        require(is_packed(entry), f'Cannot replace unpacked/link entry: {path}')
    # New header: deep copy so the source header stays pristine for the copy loop.
    new_header = json.loads(info['raw'])
    new_entries = {p: e for p, e in walk(new_header)}
    pos = 0
    plan = []  # (old_offset, old_size, replacement-bytes-or-None)
    for p, e in items:
        old = new_entries[p]
        if p in repl:
            data = repl[p]
            old['size'] = len(data)
            old['integrity'] = integrity_of([data])
            plan.append((int(e['offset']), e['size'], data))
        else:
            plan.append((int(e['offset']), e['size'], None))
        old['offset'] = str(pos)
        pos += old['size']
    head = serialize_header(new_header)
    done = False
    try:
        with src.open('rb') as fin, open(dst, 'xb') as fout:
            fout.write(head)
            for off, size, data in plan:
                if data is not None:
                    fout.write(data)
                    continue
                for chunk in read_chunks(fin, info['data_start'] + off, size):
                    fout.write(chunk)
            fout.flush()
            os.fsync(fout.fileno())
        done = True
    finally:
        if not done and dst.exists():
            dst.unlink()
    result = dict(src=str(src), dst=str(dst), dstSize=dst.stat().st_size, dstSha256=file_sha(dst),
                  replaced={p: dict(size=len(d), sha256=hashlib.sha256(d).hexdigest()) for p, d in repl.items()},
                  dataStart=len(head))
    return result


def file_sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        while chunk := fh.read(CHUNK):
            h.update(chunk)
    return h.hexdigest()


# -------------------------------------------------------------------- verify

def strip_layout(entry):
    return {k: v for k, v in entry.items() if k not in ('offset', 'size', 'integrity')}


def verify(old, new, replacements):
    """Raise AsarError on any problem; returns a summary dict."""
    repl = load_replacements(replacements)
    oi, ni = read_header(old), read_header(new)
    # header round-trip: re-serializing the parsed header reproduces the file bytes
    with open(new, 'rb') as fh:
        on_disk = fh.read(ni['data_start'])
    require(serialize_header(ni['header']) == on_disk, 'Header round-trip mismatch')
    require(json.dumps(ni['header'], separators=(',', ':'), ensure_ascii=False).encode() == ni['raw'], 'Header JSON not canonical')
    # same tree shape / non-layout attributes
    oe, ne = dict(walk(oi['header'])), dict(walk(ni['header']))
    require(list(oe) == list(ne), 'File list/order differs')
    def dirs(h):
        out = []
        def rec(p, n):
            for k, c in n['files'].items():
                if 'files' in c:
                    out.append(p + '/' + k); rec(p + '/' + k, c)
        rec('', h); return out
    require(dirs(oi['header']) == dirs(ni['header']), 'Directory list differs')
    for p in oe:
        require(strip_layout(oe[p]) == strip_layout(ne[p]), f'Attributes changed for {p}')
        if not is_packed(oe[p]):
            require(oe[p] == ne[p], f'Unpacked/link entry changed: {p}')
    for p in repl:
        require(p in ne, f'Replacement path not in new asar: {p}')
    items = packed_layout(ni)  # contiguity and total size
    require(len(items) == sum(1 for e in oe.values() if is_packed(e)), 'Packed file count differs')
    checked = identical = replaced = 0
    with open(old, 'rb') as fo, open(new, 'rb') as fn:
        for p, e in items:
            oent = oe[p]
            h = hashlib.sha256()
            for chunk in read_chunks(fn, ni['data_start'] + int(e['offset']), e['size']):
                h.update(chunk)
            actual = entry_integrity_from_file(fn, ni['data_start'], e)
            require(e['integrity'] == actual, f'Integrity invalid in new asar: {p}')
            checked += 1
            if p in repl:
                require(e['size'] == len(repl[p]) and actual['hash'] == hashlib.sha256(repl[p]).hexdigest(),
                        f'Replaced content mismatch: {p}')
                replaced += 1
            else:
                require(e['size'] == oent['size'], f'Size changed for untouched file: {p}')
                require(e['integrity'] == oent['integrity'], f'Integrity object changed for untouched file: {p}')
                oh = hashlib.sha256()
                for chunk in read_chunks(fo, oi['data_start'] + int(oent['offset']), oent['size']):
                    oh.update(chunk)
                require(oh.hexdigest() == h.hexdigest(), f'Content differs for untouched file: {p}')
                identical += 1
    return dict(newSha256=file_sha(new), filesChecked=checked, identicalFiles=identical, replacedFiles=replaced,
                unpackedOrLink=len(oe) - len(items), integrityValid=True, headerRoundTrip=True,
                oldSize=oi['size'], newSize=ni['size'])


def parse_replace(items):
    spec = {}
    for it in items or []:
        key, sep, val = it.partition('=')
        require(sep and key and val, f'--replace expects asar/path=local/file, got {it!r}')
        spec[key] = val
    return spec


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('repack'); r.add_argument('--src', required=True); r.add_argument('--dst', required=True)
    r.add_argument('--replace', action='append', required=True)
    v = sub.add_parser('verify'); v.add_argument('--old', required=True); v.add_argument('--new', required=True)
    v.add_argument('--replace', action='append', required=True)
    i = sub.add_parser('info'); i.add_argument('asar')
    a = ap.parse_args(argv)
    try:
        if a.cmd == 'repack':
            out = repack(a.src, a.dst, parse_replace(a.replace))
        elif a.cmd == 'verify':
            out = verify(a.old, a.new, parse_replace(a.replace))
        else:
            info = read_header(a.asar)
            ents = dict(walk(info['header']))
            out = dict(size=info['size'], dataStart=info['data_start'], files=len(ents),
                       packed=sum(1 for e in ents.values() if is_packed(e)), sha256=file_sha(a.asar))
    except AsarError as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        return 2
    print(json.dumps(out, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
