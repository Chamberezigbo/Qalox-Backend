/*
  Warnings:

  - You are about to alter the column `createdAt` on the `admins` table. The data in that column could be lost. The data in that column will be cast from `Timestamp(0)` to `Timestamp`.
  - You are about to alter the column `createdAt` on the `campuses` table. The data in that column could be lost. The data in that column will be cast from `Timestamp(0)` to `Timestamp`.
  - You are about to alter the column `createdAt` on the `schools` table. The data in that column could be lost. The data in that column will be cast from `Timestamp(0)` to `Timestamp`.
  - A unique constraint covering the columns `[schoolId,name]` on the table `campuses` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE `ClassGroup` DROP FOREIGN KEY `ClassGroup_classId_fkey`;

-- DropForeignKey
ALTER TABLE `Student` DROP FOREIGN KEY `Student_campusId_fkey`;

-- DropForeignKey
ALTER TABLE `Student` DROP FOREIGN KEY `Student_classId_fkey`;

-- DropForeignKey
ALTER TABLE `Student` DROP FOREIGN KEY `Student_schoolId_fkey`;

-- DropForeignKey
ALTER TABLE `Teacher` DROP FOREIGN KEY `Teacher_campusId_fkey`;

-- DropForeignKey
ALTER TABLE `Teacher` DROP FOREIGN KEY `Teacher_schoolId_fkey`;

-- DropForeignKey
ALTER TABLE `admins` DROP FOREIGN KEY `admins_campusId_fkey`;

-- DropForeignKey
ALTER TABLE `admins` DROP FOREIGN KEY `admins_schoolId_fkey`;

-- DropForeignKey
ALTER TABLE `ca_results` DROP FOREIGN KEY `ca_results_caId_fkey`;

-- DropForeignKey
ALTER TABLE `ca_results` DROP FOREIGN KEY `ca_results_studentId_fkey`;

-- DropForeignKey
ALTER TABLE `campuses` DROP FOREIGN KEY `campuses_schoolId_fkey`;

-- DropForeignKey
ALTER TABLE `classes` DROP FOREIGN KEY `classes_campusId_fkey`;

-- DropForeignKey
ALTER TABLE `classes` DROP FOREIGN KEY `classes_schoolId_fkey`;

-- DropForeignKey
ALTER TABLE `classes` DROP FOREIGN KEY `classes_teacherId_fkey`;

-- DropForeignKey
ALTER TABLE `continuous_assessments` DROP FOREIGN KEY `continuous_assessments_classId_fkey`;

-- DropForeignKey
ALTER TABLE `continuous_assessments` DROP FOREIGN KEY `continuous_assessments_subjectId_fkey`;

-- DropForeignKey
ALTER TABLE `exam_results` DROP FOREIGN KEY `exam_results_examId_fkey`;

-- DropForeignKey
ALTER TABLE `exam_results` DROP FOREIGN KEY `exam_results_studentId_fkey`;

-- DropForeignKey
ALTER TABLE `exams` DROP FOREIGN KEY `exams_classId_fkey`;

-- DropForeignKey
ALTER TABLE `exams` DROP FOREIGN KEY `exams_subjectId_fkey`;

-- DropForeignKey
ALTER TABLE `subjects` DROP FOREIGN KEY `subjects_campusId_fkey`;

-- DropForeignKey
ALTER TABLE `subjects` DROP FOREIGN KEY `subjects_schoolId_fkey`;

-- DropForeignKey
ALTER TABLE `teacher_subjects` DROP FOREIGN KEY `teacher_subjects_subjectId_fkey`;

-- DropForeignKey
ALTER TABLE `teacher_subjects` DROP FOREIGN KEY `teacher_subjects_teacherId_fkey`;

-- AlterTable
ALTER TABLE `admins` MODIFY `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- AlterTable
ALTER TABLE `campuses` MODIFY `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- AlterTable
ALTER TABLE `schools` MODIFY `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX `campuses_schoolId_name_key` ON `campuses`(`schoolId`, `name`);
