-- Barcodes imported with trailing spaces (Oracle CHAR padding / aligned exports) lose them, so they match the
-- file and future imports (which now remove trailing spaces). IGNORE skips a row whose trimmed barcode already
-- exists for the same INSERT_TIME: that is the same scan imported twice (before and after the padding was
-- kept); such rows stay as they are and are listed by:
--   SELECT suit_barcode, insert_time FROM issue_import WHERE suit_barcode <> RTRIM(suit_barcode);
UPDATE IGNORE issue_import SET suit_barcode = RTRIM(suit_barcode) WHERE suit_barcode <> RTRIM(suit_barcode);
