/*
  Warnings:

  - You are about to alter the column `createdAt` on the `admins` table. The data in that column could be lost. The data in that column will be cast from `Timestamp(0)` to `Timestamp`.
  - You are about to alter the column `createdAt` on the `campuses` table. The data in that column could be lost. The data in that column will be cast from `Timestamp(0)` to `Timestamp`.
  - You are about to alter the column `createdAt` on the `schools` table. The data in that column could be lost. The data in that column will be cast from `Timestamp(0)` to `Timestamp`.
  - A unique constraint covering the columns `[studentId,caId,academicSessionId]` on the table `ca_results` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[classId,subjectId,name]` on the table `continuous_assessments` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[studentId,examId,academicSessionId]` on the table `exam_results` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[classId,subjectId,name]` on the table `exams` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX `continuous_assessments_createdByAdminId_classId_name_key` ON `continuous_assessments`;

-- DropIndex
DROP INDEX `exams_createdByAdminId_classId_name_key` ON `exams`;

-- AlterTable
ALTER TABLE `admins` MODIFY `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- AlterTable
ALTER TABLE `campuses` MODIFY `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- AlterTable
ALTER TABLE `schools` MODIFY `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX `ca_results_studentId_caId_academicSessionId_key` ON `ca_results`(`studentId`, `caId`, `academicSessionId`);

-- CreateIndex
CREATE UNIQUE INDEX `continuous_assessments_classId_subjectId_name_key` ON `continuous_assessments`(`classId`, `subjectId`, `name`);

-- CreateIndex
CREATE UNIQUE INDEX `exam_results_studentId_examId_academicSessionId_key` ON `exam_results`(`studentId`, `examId`, `academicSessionId`);

-- CreateIndex
CREATE UNIQUE INDEX `exams_classId_subjectId_name_key` ON `exams`(`classId`, `subjectId`, `name`);
