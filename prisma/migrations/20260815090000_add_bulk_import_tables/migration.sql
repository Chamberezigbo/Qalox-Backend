-- Bulk import of students/staff from a spreadsheet, PDF or photo.
--
-- The job and its extracted rows live in the database rather than in process
-- memory because an admin typically uploads, then spends several minutes fixing
-- bad rows before confirming. An in-memory job would be lost on a restart or on
-- a second server instance, and the admin's corrections with it.
--
-- `id` is a client-visible string ("imp_<random>"), not an auto-increment, so it
-- can be handed to the frontend without leaking a row count.
--
-- The DROP is safe: an earlier draft of this table reached some databases via
-- `prisma db push` (no migration was ever committed for it) and was never
-- written to — it held zero rows everywhere it existed. Its shape (entityType,
-- previewData, totalRows...) has no overlap worth migrating.
DROP TABLE IF EXISTS `bulk_import_jobs`;

CREATE TABLE `bulk_import_jobs` (
  `id` VARCHAR(64) NOT NULL,
  `schoolId` INTEGER NOT NULL,
  `adminId` INTEGER NOT NULL,
  `entity` VARCHAR(16) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'processing',
  `progress` INTEGER NOT NULL DEFAULT 0,
  `stage` VARCHAR(64) NOT NULL DEFAULT 'Queued',
  `errorMessage` TEXT NULL,
  `fileName` VARCHAR(255) NOT NULL,
  `fileSize` INTEGER NOT NULL DEFAULT 0,
  `mimeType` VARCHAR(128) NOT NULL DEFAULT '',
  `allowWarnings` BOOLEAN NOT NULL DEFAULT true,
  `columnsJson` LONGTEXT NULL,
  `summaryJson` LONGTEXT NULL,
  `completedAt` DATETIME(3) NULL,
  `confirmedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `bulk_import_jobs_schoolId_idx`(`schoolId`),
  INDEX `bulk_import_jobs_adminId_idx`(`adminId`),
  INDEX `bulk_import_jobs_status_idx`(`status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- One row per extracted record. Split out from the job (rather than stored as a
-- JSON blob on it) so editing a single row is an UPDATE of that row — a blob
-- would need a read-modify-write of the whole set and would silently drop one
-- edit whenever two rows are corrected at the same time.
CREATE TABLE `bulk_import_records` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `jobId` VARCHAR(64) NOT NULL,
  `recordId` VARCHAR(32) NOT NULL,
  `rowNumber` INTEGER NOT NULL,
  `dataJson` LONGTEXT NOT NULL,
  `isValid` BOOLEAN NOT NULL DEFAULT false,
  `isDuplicate` BOOLEAN NOT NULL DEFAULT false,
  `errorsJson` LONGTEXT NOT NULL,
  `warningsJson` LONGTEXT NOT NULL,
  `importedAt` DATETIME(3) NULL,
  `failureReason` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `bulk_import_records_jobId_recordId_key`(`jobId`, `recordId`),
  INDEX `bulk_import_records_jobId_rowNumber_idx`(`jobId`, `rowNumber`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- No FOREIGN KEY here on purpose: this schema uses relationMode = "prisma", so
-- referential actions (the record -> job cascade) are enforced by the Prisma
-- client, not by the database.
