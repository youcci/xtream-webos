#!/usr/bin/env python3
"""Build the experimental ARM32 entry library using the owner's private TV libc."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import subprocess

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--clang', default='clang')
    parser.add_argument('--lld', default='ld.lld')
    parser.add_argument('--libraries', type=Path, required=True,
                        help='Private directory containing the original TV libc.so.6')
    parser.add_argument('--output', type=Path, default=ROOT.parents[1] / 'dist' / 'early-entry')
    args = parser.parse_args()
    libraries = args.libraries.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    required = [libraries / 'libc.so.6']
    if not all(p.is_file() for p in required):
        parser.error('Provide the original TV libc.so.6 in --libraries; do not put it in the repository.')
    flags = ['-target', 'armv7-linux-gnueabi', '-mfloat-abi=soft', '-march=armv7-a', '-O2',
             '-fPIC', '-fno-stack-protector', '-ffreestanding', '-Wall', '-Wextra', '-Werror']
    commands = []
    for name in ('early-marker',):
        commands.append([args.clang] + flags + ['-c', str(ROOT / (name + '.c')), '-o', str(output / (name + '.o'))])
    harden = ['-z', 'relro', '-z', 'now', '-z', 'noexecstack', '--hash-style=both']
    commands.append([args.lld, '-shared', '-soname', 'libxtream-early.so'] + harden +
                    [str(output / 'early-marker.o'), str(required[0]), '-o', str(output / 'libxtream-early.so')])
    for command in commands:
        subprocess.run(command, check=True)
    for name, kind in [('libxtream-early.so', 3)]:
        target = output / name
        data = target.read_bytes()
        header = struct.unpack('<16sHHIIIIIHHHHHH', data[:52])
        if data[:6] != b'\x7fELF\x01\x01' or header[1] != kind or header[2] != 40 or header[7] & 0x600 != 0x200:
            raise RuntimeError('Output does not match the tested ARM32 soft-float ABI.')
        target.chmod(0o700 if kind == 2 else 0o600)
    manifest = {'commands': commands, 'files': {str(p): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in required + [output / 'libxtream-early.so']}}
    record = output / 'build.private.json'
    record.write_text(json.dumps(manifest, indent=2) + '\n')
    record.chmod(0o600)
    print('Built ARM32 soft-float entry library in', output)
    print('Keep the build record and supplied TV libraries private.')


if __name__ == '__main__':
    main()
