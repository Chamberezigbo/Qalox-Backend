# Task Management

## 🔥 Immediate Focus

- [ ] Get endpoint for CA  for school wide template and class
- [ ] Return session name in student details and edit student endpoint.
- [ ] add student passport for create student


---

## 🚧 In Progress
- [] Students login 
- [] students metrics dashboard
- [] students check results endpoint


---

## ✅ Completed

### Authentication & Access
- [x] JWT authentication
- [x] Role-based access control

### School Setup
- [x] Campus creation (POST /setup/campus)
- [x] Class creation (POST /setup/class)
- [x] Removed CA/Exam creation from setup — was creating records without subjectId

### Grading Scheme
- [x] Create grading scheme (POST /admin/grading/create)
- [x] Add classes to scheme (POST /admin/grading/:schemeId/classes)
- [x] Delete remark rule (DELETE /admin/grading/remark/:ruleId)

### Assessment System Refactor
- [x] Identified root cause — CAs were created without subjectId during setup
- [x] Removed assign-subject endpoints (were a workaround, no longer needed)
- [x] Removed standalone createCA and createExam endpoints (replaced by auto-generation)
- [x] Fixed unique constraint on ContinuousAssessment and Exam (classId + subjectId + name)
- [x] Added CATemplate model to schema + migration
- [x] Added ClassSubject model to schema + migration
- [x] CA Template endpoint (POST /admin/ca-template) — school-wide or class-specific override
- [x] Documented full refactor in docs/assessment-refactor.md

### Result Computing
- [x] Teacher enters CA scores (POST /teacher/scores/ca)
- [x] Teacher enters Exam scores (POST /teacher/scores/exam)
- [x] Computed result sheet per subject (GET /teacher/results?classId=&subjectId=&academicSessionId=)
- [x] Grading applied automatically from GradingScheme

### Student Management
- [x] Create student
- [x] Get students
- [x] Update student
- [x] Change student class
- [x] AcademicSession as separate table

- [x] Assign subjects to class endpoint (POST /admin/class-subject/assign) → auto-generates CAs + Exams from template
- [x] Get subjects for a class (GET /admin/class-subject/:classId)

- [x] Broadsheet — all subjects side by side per student (GET /teacher/results/broadsheet)
- [x] Position/ranking using usePosition flag on GradingScheme
- [x] Result publication — admin reviews and publishes results (snapshot to DB)
- [x] Lock results after submission — teachers cannot edit after submitting
- [x] Result submission confirmation

---

## 📌 Backlog

- [ ] Result audit trail
- [ ] Export results (PDF / CSV)
- [ ] Parent result view access
- [ ] Teacher result remark setup — add class it should be applicable to + delete remark endpoint
