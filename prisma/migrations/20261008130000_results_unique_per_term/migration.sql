-- A result belongs to a TERM, not just a session.
--
-- CAResult, ExamResult, PublishedResult and ResultSubmission were unique per
-- (…, academicSessionId), so a second term's score for the same student and CA
-- hit the first term's row, and publishing Second Term would have been refused
-- because First Term was already published. Adding termId to each key lets a
-- session hold more than one term.
--
-- Safe on existing data: each new key is the old key plus one column, so no
-- existing row can violate it. (MySQL treats NULLs as distinct in a unique
-- index; the application always writes a termId now.)

-- DropIndex
DROP INDEX `ca_results_studentId_caId_academicSessionId_key` ON `ca_results`;

-- DropIndex
DROP INDEX `exam_results_studentId_examId_academicSessionId_key` ON `exam_results`;

-- DropIndex
DROP INDEX `published_results_classId_subjectId_academicSessionId_key` ON `published_results`;

-- DropIndex
DROP INDEX `result_submissions_classId_subjectId_academicSessionId_staff_key` ON `result_submissions`;

-- CreateIndex
CREATE UNIQUE INDEX `ca_results_studentId_caId_academicSessionId_termId_key` ON `ca_results`(`studentId`, `caId`, `academicSessionId`, `termId`);

-- CreateIndex
CREATE UNIQUE INDEX `exam_results_studentId_examId_academicSessionId_termId_key` ON `exam_results`(`studentId`, `examId`, `academicSessionId`, `termId`);

-- CreateIndex
CREATE UNIQUE INDEX `published_results_classId_subjectId_academicSessionId_termId_key` ON `published_results`(`classId`, `subjectId`, `academicSessionId`, `termId`);

-- CreateIndex
CREATE UNIQUE INDEX `result_submissions_classId_subjectId_academicSessionId_termI_key` ON `result_submissions`(`classId`, `subjectId`, `academicSessionId`, `termId`, `staffId`);
