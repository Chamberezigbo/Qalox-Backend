-- Drop the three optional fields from school tokens.
--
-- The Marketer Portal's "Generate Token" modal no longer collects pupil, class
-- or subject, and nothing else in the system reads or writes them: the Super
-- Admin token screens use the separate `tokens` table (model Token), which has
-- no such columns, and no report, export or analytics query references them.
--
-- Verified lossless before running: all 4 existing rows had NULL in all three
-- columns, so no data is destroyed by this migration.
ALTER TABLE `school_tokens`
  DROP COLUMN `pupil`,
  DROP COLUMN `class`,
  DROP COLUMN `subject`;
