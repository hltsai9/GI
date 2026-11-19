#!/bin/sh
# With ISSUE_SOURCE=mock and no mock data yet, generate it first (testing without Oracle).
set -e
if [ "${ISSUE_SOURCE:-mock}" = "mock" ] && [ ! -f "${MOCK_ORACLE_DIR:-./mock-oracle/data}/issues.ndjson" ]; then
  echo "Generating mock Oracle data in ${MOCK_ORACLE_DIR:-./mock-oracle/data}"
  node dist/mock-oracle/generate.js --out "${MOCK_ORACLE_DIR:-./mock-oracle/data}"
fi
exec "$@"
