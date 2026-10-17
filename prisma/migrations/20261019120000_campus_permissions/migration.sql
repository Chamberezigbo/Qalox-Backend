-- A sub-admin's permissions on ONE campus (JSON array of keys). NULL = use the
-- sub-admin's own permissions, so every existing row behaves exactly as before.
ALTER TABLE `admin_campus_access` ADD COLUMN `permissions` TEXT NULL;
