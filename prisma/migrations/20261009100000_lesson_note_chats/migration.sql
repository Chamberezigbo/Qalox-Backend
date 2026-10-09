-- CreateTable
CREATE TABLE `lesson_note_chats` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `staffId` INTEGER NOT NULL,
    `classId` INTEGER NOT NULL,
    `subjectId` INTEGER NOT NULL,
    `academicTermId` INTEGER NOT NULL,
    `schemeOfWorkId` INTEGER NOT NULL,
    `topic` VARCHAR(255) NULL,
    `weekRange` VARCHAR(100) NULL,
    `duration` VARCHAR(50) NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'open',
    `lessonNoteId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `lesson_note_chats_schoolId_idx`(`schoolId`),
    INDEX `lesson_note_chats_staffId_idx`(`staffId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `lesson_note_chat_messages` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `chatId` INTEGER NOT NULL,
    `role` VARCHAR(8) NOT NULL,
    `kind` VARCHAR(16) NOT NULL DEFAULT 'chat',
    `content` TEXT NOT NULL,
    `inputTokens` INTEGER NULL,
    `outputTokens` INTEGER NULL,
    `creditsCharged` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `lesson_note_chat_messages_chatId_idx`(`chatId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

