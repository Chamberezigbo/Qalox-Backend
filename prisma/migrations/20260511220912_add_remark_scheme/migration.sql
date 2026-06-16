-- CreateTable
CREATE TABLE `remark_schemes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `remark_schemes_schoolId_key`(`schoolId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `remark_rules` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schemeId` INTEGER NOT NULL,
    `minScore` INTEGER NOT NULL,
    `maxScore` INTEGER NOT NULL,
    `remark` LONGTEXT NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `remark_schemes` ADD CONSTRAINT `remark_schemes_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `schools`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `remark_rules` ADD CONSTRAINT `remark_rules_schemeId_fkey` FOREIGN KEY (`schemeId`) REFERENCES `remark_schemes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
