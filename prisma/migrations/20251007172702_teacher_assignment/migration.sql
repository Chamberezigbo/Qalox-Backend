/*
  Warnings:

  - You are about to alter the column `createdAt` on the `admins` table. The data in that column could be lost. The data in that column will be cast from `Timestamp(0)` to `Timestamp`.
  - You are about to alter the column `createdAt` on the `campuses` table. The data in that column could be lost. The data in that column will be cast from `Timestamp(0)` to `Timestamp`.
  - You are about to alter the column `createdAt` on the `schools` table. The data in that column could be lost. The data in that column will be cast from `Timestamp(0)` to `Timestamp`.
  - A unique constraint covering the columns `[staffId,classId,subjectId,campusId]` on the table `teacher_assignments` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX `TeacherAssignment_unique` ON `teacher_assignments`;

-- AlterTable
ALTER TABLE `admins` MODIFY `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- AlterTable
ALTER TABLE `campuses` MODIFY `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- AlterTable
ALTER TABLE `schools` MODIFY `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX `teacher_assignments_staffId_classId_subjectId_campusId_key` ON `teacher_assignments`(`staffId`, `classId`, `subjectId`, `campusId`);
