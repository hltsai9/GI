from __future__ import annotations

from ..config import config
from .source import IssueSource, MasterSource

_source: IssueSource | None = None


class NoAutomaticSource(RuntimeError):
    """ISSUE_SOURCE=csv: nothing to poll; issues arrive by CSV upload."""


def get_issue_source() -> IssueSource:
    global _source
    if _source is None:
        if config.ISSUE_SOURCE == "csv":
            raise NoAutomaticSource("ISSUE_SOURCE=csv: issues come only from CSV uploads (Settings › Import)")
        if config.ISSUE_SOURCE == "oracle":
            from .oracle_source import OracleIssueSource
            _source = OracleIssueSource(config)
        else:
            from .mock_source import MockIssueSource
            _source = MockIssueSource.from_dir()
    return _source


def set_issue_source(s: IssueSource | None) -> None:
    global _source
    _source = s


def get_master_source() -> MasterSource | None:
    """The live barcode master: the Oracle table (ORACLE_BARCODE_MASTER_TABLE) or the mock's. None when there
    is none (ISSUE_SOURCE=csv, or no table configured): then only the CSV uploads fill GI's copy."""
    if config.ISSUE_SOURCE == "csv" or (config.ISSUE_SOURCE == "oracle" and not config.ORACLE_BARCODE_MASTER_TABLE):
        return None
    from .importer import live_master
    return live_master(get_issue_source())
