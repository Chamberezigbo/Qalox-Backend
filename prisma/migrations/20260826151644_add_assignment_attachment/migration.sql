-- Adds an optional file attachment to assignments — a teacher previously
-- had no way to include equations, diagrams, or a scanned worksheet, only
-- plain-text title/description.
--
-- `attachmentUrl` stores "r2:<key>", resolved to a fresh presigned URL on
-- read via schoolMediaUrl() (same pattern already used for School
-- logoUrl/stampUrl) — never a raw URL, since the private R2 bucket has none.
-- `attachmentName` is the original filename, kept only for display.
ALTER TABLE `assignments`
  ADD COLUMN `attachmentUrl` VARCHAR(500) NULL,
  ADD COLUMN `attachmentName` VARCHAR(255) NULL;
