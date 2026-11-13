-- DropIndex
DROP INDEX `fee_structures_classId_term_session_key` ON `fee_structures`;

-- AlterTable
ALTER TABLE `fee_structures` ADD COLUMN `audience` VARCHAR(10) NOT NULL DEFAULT 'all',
    ADD COLUMN `dueDate` DATE NULL,
    ADD COLUMN `note` VARCHAR(500) NULL,
    ADD COLUMN `title` VARCHAR(100) NOT NULL DEFAULT 'School Fees';

-- AlterTable
ALTER TABLE `students` ADD COLUMN `feeCategory` VARCHAR(10) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `fee_structures_classId_term_session_title_audience_key` ON `fee_structures`(`classId`, `term`, `session`, `title`, `audience`);
