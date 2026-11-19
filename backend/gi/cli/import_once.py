"""Runs one import (and optionally the sweep) against the configured source. Dev helper.
Usage: python -m gi.cli.import_once [--backfill] [--sweep]"""
import sys
import time

from ..importing import get_issue_source
from ..importing.importer import poll, sweep

if __name__ == "__main__":
    source = get_issue_source()
    t0 = time.time()
    print(poll(source, kind="backfill" if "--backfill" in sys.argv else "poll"))
    if "--sweep" in sys.argv:
        print(sweep(source))
    print(f"took {time.time() - t0:.1f} s")
    source.close()
