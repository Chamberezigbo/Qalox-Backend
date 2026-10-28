-- AlterTable
ALTER TABLE `schools` ADD COLUMN `chatStudentsEnabled` BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE `chat_conversations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `campusId` INTEGER NULL,
    `kind` VARCHAR(16) NOT NULL,
    `pairKey` VARCHAR(64) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastMessageAt` DATETIME(3) NULL,
    `lastMessagePreview` VARCHAR(140) NULL,

    INDEX `chat_conversations_schoolId_lastMessageAt_idx`(`schoolId`, `lastMessageAt`),
    UNIQUE INDEX `chat_conversations_schoolId_pairKey_key`(`schoolId`, `pairKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chat_participants` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `conversationId` INTEGER NOT NULL,
    `userType` VARCHAR(8) NOT NULL,
    `userId` INTEGER NOT NULL,
    `lastReadMessageId` INTEGER NOT NULL DEFAULT 0,

    INDEX `chat_participants_userType_userId_idx`(`userType`, `userId`),
    UNIQUE INDEX `chat_participants_conversationId_userType_userId_key`(`conversationId`, `userType`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chat_messages` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `conversationId` INTEGER NOT NULL,
    `senderType` VARCHAR(8) NOT NULL,
    `senderId` INTEGER NOT NULL,
    `body` TEXT NULL,
    `attachmentKey` VARCHAR(255) NULL,
    `attachmentName` VARCHAR(255) NULL,
    `attachmentMime` VARCHAR(100) NULL,
    `sentAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `chat_messages_conversationId_id_idx`(`conversationId`, `id`),
    INDEX `chat_messages_senderType_senderId_sentAt_idx`(`senderType`, `senderId`, `sentAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
