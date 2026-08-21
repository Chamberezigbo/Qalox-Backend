-- Adds online (Flutterwave) payment tracking to the existing `payments`
-- table, which previously only represented payments an admin recorded
-- manually (Cash/Bank Transfer/Card, always implicitly successful).
--
-- `flwReference` identifies a pending Flutterwave charge so the webhook can
-- find its Payment row; `status` distinguishes a not-yet-confirmed online
-- payment ("pending") from one whose transfer landed ("success") or failed.
-- Existing rows all default to "success" since they were only ever created
-- for payments an admin had already confirmed by hand.
ALTER TABLE `payments`
  ADD COLUMN `flwReference` VARCHAR(100) NULL,
  ADD COLUMN `status` VARCHAR(20) NOT NULL DEFAULT 'success';

ALTER TABLE `payments`
  ADD UNIQUE INDEX `payments_flwReference_key`(`flwReference`);
