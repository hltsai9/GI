-- 2026-11-25: type, color, size and level values are compared without capitals and surrounding spaces
-- ("White" is "WHITE"). No table changes; when this file is applied, GI re-checks the existing data once
-- (gi/server.py → importer.recheck_values): barcode master ties that only differed in capitals, scans
-- whose versions only differed in capitals, and rows held because of another spelling of a mapped value.
DO 0;
