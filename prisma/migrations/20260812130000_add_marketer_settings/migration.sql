-- Marketer settings persistence.
-- Additive and safe: notificationPreferences is nullable, twoFactorEnabled
-- defaults to false, which is the correct state for every existing row (no
-- marketer has real 2FA today — the previous handlers persisted nothing).
ALTER TABLE `admins`
  ADD COLUMN `notificationPreferences` TEXT NULL,
  ADD COLUMN `twoFactorEnabled` BOOLEAN NOT NULL DEFAULT false;
