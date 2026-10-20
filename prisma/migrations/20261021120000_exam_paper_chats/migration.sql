-- CreateTable
CREATE TABLE `exam_paper_chats` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `staffId` INTEGER NOT NULL,
    `classId` INTEGER NOT NULL,
    `subjectId` INTEGER NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `schemeOfWorkId` INTEGER NULL,
    `paperJson` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `exam_paper_chats_schoolId_idx`(`schoolId`),
    INDEX `exam_paper_chats_staffId_idx`(`staffId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `exam_paper_chat_messages` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `chatId` INTEGER NOT NULL,
    `role` VARCHAR(8) NOT NULL,
    `content` TEXT NOT NULL,
    `attachmentsJson` TEXT NULL,
    `inputTokens` INTEGER NULL,
    `outputTokens` INTEGER NULL,
    `creditsCharged` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `exam_paper_chat_messages_chatId_idx`(`chatId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
