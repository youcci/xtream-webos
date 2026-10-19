#!/usr/bin/env python3
"""Check the publishable file set for common accidental private artifacts."""
from pathlib import Path
import re
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
files = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=root).decode().split('\0')
errors = []
for name in filter(None, files):
    path = root / name
    if not path.is_file():
        continue
    if path.suffix.lower() in ('.ipk', '.sqlite', '.db', '.pem', '.key') or '.private.' in name:
        errors.append(name + ': private/generated artifact')
    if name.startswith(('runtime/originals/', 'runtime/patches/', 'backups/')):
        errors.append(name + ': firmware/backup artifact')
    data = path.read_bytes()
    if b'\x00' in data:
        continue
    text = data.decode('utf-8', 'replace')
    patterns = [r'-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----',
                r'gh[pousr]_[A-Za-z0-9]{30,}',
                r'(?i)(?<!&)[?&](?:password|username)=(?!=)[^\s"\'<>]+',
                r'(?i)(?:token[=:]["\']?)[0-9a-f]{64}']
    if any(re.search(pattern, text) for pattern in patterns):
        errors.append(name + ': possible secret')
if errors:
    print('\n'.join(errors), file=sys.stderr)
    sys.exit(1)
print('Public-content checks passed for', len(list(filter(None, files))), 'files.')
