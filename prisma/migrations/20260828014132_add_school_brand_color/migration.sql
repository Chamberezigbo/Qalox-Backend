-- Stores the dominant color extracted from a school's uploaded logo, used
-- to re-theme the frontend away from the default indigo. Nullable: a school
-- that predates this feature (or whose logo yielded no usable color) simply
-- keeps the default until the backfill script or a future re-upload sets it.
ALTER TABLE `schools`
  ADD COLUMN `brandColor` VARCHAR(7) NULL;
