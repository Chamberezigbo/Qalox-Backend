/*
  Warnings:

  - You are about to alter the column `createdAt` on the `admins` table. The data in that column could be lost. The data in that column will be cast from `Timestamp(0)` to `Timestamp`.
  - You are about to alter the column `createdAt` on the `campuses` table. The data in that column could be lost. The data in that column will be cast from `Timestamp(0)` to `Timestamp`.
  - You are about to alter the column `createdAt` on the `schools` table. The data in that column could be lost. The data in that column will be cast from `Timestamp(0)` to `Timestamp`.

*/
-- DropIndex
DROP INDEX `ClassGroup_classId_fkey` ON `ClassGroup`;

-- DropIndex
DROP INDEX `Student_campusId_fkey` ON `Student`;

-- DropIndex
DROP INDEX `Student_classId_fkey` ON `Student`;

-- DropIndex
DROP INDEX `Student_schoolId_fkey` ON `Student`;

-- DropIndex
DROP INDEX `Teacher_campusId_fkey` ON `Teacher`;

-- DropIndex
DROP INDEX `Teacher_schoolId_fkey` ON `Teacher`;

-- DropIndex
DROP INDEX `admins_campusId_fkey` ON `admins`;

-- DropIndex
DROP INDEX `admins_schoolId_fkey` ON `admins`;

-- DropIndex
DROP INDEX `ca_results_caId_fkey` ON `ca_results`;

-- DropIndex
DROP INDEX `ca_results_studentId_fkey` ON `ca_results`;

-- DropIndex
DROP INDEX `classes_campusId_fkey` ON `classes`;

-- DropIndex
DROP INDEX `classes_schoolId_fkey` ON `classes`;

-- DropIndex
DROP INDEX `classes_teacherId_fkey` ON `classes`;

-- DropIndex
DROP INDEX `continuous_assessments_classId_fkey` ON `continuous_assessments`;

-- DropIndex
DROP INDEX `continuous_assessments_subjectId_fkey` ON `continuous_assessments`;

-- DropIndex
DROP INDEX `exam_results_examId_fkey` ON `exam_results`;

-- DropIndex
DROP INDEX `exam_results_studentId_fkey` ON `exam_results`;

-- DropIndex
DROP INDEX `exams_classId_fkey` ON `exams`;

-- DropIndex
DROP INDEX `exams_subjectId_fkey` ON `exams`;

-- DropIndex
DROP INDEX `subjects_campusId_fkey` ON `subjects`;

-- DropIndex
DROP INDEX `subjects_schoolId_fkey` ON `subjects`;

-- DropIndex
DROP INDEX `teacher_subjects_subjectId_fkey` ON `teacher_subjects`;

-- AlterTable
ALTER TABLE `admins` MODIFY `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- AlterTable
ALTER TABLE `campuses` MODIFY `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- AlterTable
ALTER TABLE `schools` MODIFY `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
