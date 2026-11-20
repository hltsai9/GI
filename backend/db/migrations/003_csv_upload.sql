-- Issue rows can also be imported from a CSV export of the Oracle table (Settings › Import),
-- for test environments that cannot reach Oracle. The run records the file name.
ALTER TABLE sync_run
  MODIFY kind ENUM('poll','sweep','backfill','upload') NOT NULL,
  ADD COLUMN note VARCHAR(255) NULL AFTER kind;
