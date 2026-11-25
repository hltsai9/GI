"""Runs one import (and optionally the barcode master read and the sweep) against the configured source. Dev helper.
Usage: python -m gi.cli.import_once [--master] [--backfill] [--sweep]"""
import sys
import time

from ..importing import get_issue_source, get_master_source
from ..importing.importer import poll, sweep, sync_master

if __name__ == "__main__":
    source = get_issue_source()
    t0 = time.time()
    if "--master" in sys.argv:
        master = get_master_source()
        print(sync_master(master) if master else "no barcode master to read (ORACLE_BARCODE_MASTER_TABLE not set)")
    print(poll(source, kind="backfill" if "--backfill" in sys.argv else "poll"))
    if "--sweep" in sys.argv:
        print(sweep(source))
    print(f"took {time.time() - t0:.1f} s")
    source.close()
