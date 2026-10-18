-- CA templates per campus: NULL campus = the school-wide template, as before.
ALTER TABLE `ca_templates` ADD COLUMN `campusId` INTEGER NULL;
DROP INDEX `ca_templates_schoolId_classId_name_key` ON `ca_templates`;
CREATE UNIQUE INDEX `ca_templates_schoolId_campusId_classId_name_key` ON `ca_templates`(`schoolId`, `campusId`, `classId`, `name`);

-- A campus's own logo and stamp (NULL = use the school's).
ALTER TABLE `campuses` ADD COLUMN `logoUrl` VARCHAR(255) NULL, ADD COLUMN `stampUrl` VARCHAR(255) NULL, ADD COLUMN `brandColor` VARCHAR(7) NULL;
