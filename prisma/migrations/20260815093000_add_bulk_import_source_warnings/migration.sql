-- Warnings raised while READING the file, as opposed to while validating it.
--
-- Validation runs against the normalised value, so it cannot rederive them: by
-- the time a date is "2012-04-09" there is no way to know the file said
-- "09/04/2012" and could have meant 4 September. Kept in their own column so
-- revalidating a row (which happens on every edit, to any row in the job)
-- re-attaches them instead of quietly dropping a flag nobody has looked at yet.
ALTER TABLE `bulk_import_records` ADD COLUMN `sourceWarningsJson` LONGTEXT NULL;
