-- Progress of a CSV upload (Settings › Import shows "Importing N of M rows"): the number of issue rows in
-- the file, and how many rows were skipped because their STATE is not an issue.
ALTER TABLE sync_run
  ADD COLUMN rows_total INT UNSIGNED NULL AFTER rows_read,
  ADD COLUMN rows_other_state INT UNSIGNED NULL AFTER rows_total;
