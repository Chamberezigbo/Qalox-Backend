-- Add per-marketer commission rate overrides to the Admin model.
-- These columns allow admins to set custom commission rates for individual marketers,
-- which take precedence over the legacy commissionRate and global PlatformSettings.

ALTER TABLE `admins`
  ADD COLUMN `newSchoolCommissionRate` DOUBLE NULL,
  ADD COLUMN `renewalCommissionRate` DOUBLE NULL;
