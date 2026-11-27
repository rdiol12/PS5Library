"""Reject native storefront ELFs that still contain the live event worker."""
import subprocess
import sys

for filename in sys.argv[2:]:
    symbols = subprocess.check_output([sys.argv[1], '-C', filename], text=True, timeout=15)
    assert 'Storefront::startLive()::{lambda()#1}' not in symbols, (
        f'{filename}: live /events AsyncWorker is linked into the native storefront')
    print(f'{filename}: no live event worker PASS')
