# Assessment System Refactor — Technical Document

**Project:** Ecolex School Management System  
**Date:** April 2026  
**Author:** Development Team  

---

## 1. Overview

This document explains the decisions made during the refactoring of the assessment (CA and Exam) creation system. It covers what the old design was, what problems it caused, and what the new design looks like and why.

---

## 2. The Old Design — What We Started With

The school setup flow created Continuous Assessments (CAs) and Exams during onboarding. CAs were created per class, with no subject attached.

**Old DB records:**

| id | classId | subjectId | name |
|----|---------|-----------|------|
| 1  | 1       | NULL      | CA1  |
| 2  | 1       | NULL      | CA2  |
| 3  | 1       | NULL      | Exam |

**Old setup order:**
```
Step 1 → Create campuses
Step 2 → Create classes
Step 3 → Create CAs and Exams   ← subjects do not exist yet
Step 4 → Create subjects (later, in dashboard)
```

---

## 3. Problems Identified

### Problem 1 — Subjects did not exist at setup time

CAs were created in the same setup step as classes. At that point, subjects had not been created yet. This meant every CA was saved with `subjectId = NULL`.

A CA without a subject has no identity. When a teacher enters Maths scores, the system cannot separate them from English scores — everything is lumped together under the same class.

---

### Problem 2 — One CA per class instead of one CA per subject

The old design created one CA record per class. The correct design is one CA record per subject per class.

**Wrong:**
```
Class 1 → CA1 (subjectId: NULL)
```

**Correct:**
```
Class 1 → CA1 for English   (subjectId: 1)
Class 1 → CA1 for Maths     (subjectId: 2)
Class 1 → CA1 for Biology   (subjectId: 3)
```

Without this separation, two subject teachers pointing to the same `caId` would produce meaningless mixed totals in result computation.

---

### Problem 3 — CA structure varies per school and class

Different schools have different assessment structures:
- Some schools use CA1, CA2, CA3 + Final Exam for all classes
- Some classes within the same school may have a simpler or more complex structure

There was no way to configure this. The old system created whatever was passed during setup with no flexibility for future changes.

---

### Problem 4 — No direct link between subjects and classes

Subjects were only connected to classes through `TeacherAssignment`. This meant a subject had no class until a teacher was assigned to it — which is the wrong dependency.

**Wrong dependency:**
```
Subject belongs to Class only because a Teacher is assigned to it
```

**Correct:**
```
Subject belongs to Class independently of any teacher
Teacher is assigned to that Class + Subject combination separately
```

---

## 4. Refactoring Decisions

### 4.1 — Remove CA and Exam creation from setup

**Files changed:**
- `res/controller/admin/setup.js` — deleted `createAssessmentsAndExam` function
- `res/routes/setup.js` — deleted `POST /setup/ca` route
- `res/schemas/setupSchema.js` — removed `continuousAssessmentSchema`, `examSchema`, `requestSchema`
- `res/controller/admin/setup.js` — removed unused `validate` and `date` imports

**Why:**  
CAs cannot be properly created until subjects exist. Setup runs before subjects are created. Moving CA creation out of setup removes this timing conflict entirely.

**Setup now only handles:**
- Creating campuses
- Creating classes

---

### 4.2 — Remove assign-subject endpoints

**Files changed:**
- `res/Services/AssessmentService.ts` — removed `assignCAToSubject`, `assignExamToSubject`
- `res/controller/admin/AssessmentController.ts` — removed matching controller methods
- `res/controller/teacher/TeacherController.ts` — removed matching controller methods
- `res/routes/admin/admin.js` — removed `PATCH /ca/assign-subject`, `PATCH /exam/assign-subject`
- `res/routes/teacher.js` — removed same routes

**Why:**  
These endpoints were a workaround to fix NULLs in existing data. With the new design, CAs are always created with a `subjectId` from the start. There is nothing to reassign.

---

### 4.3 — Remove standalone createCA and createExam endpoints

**Files changed:**
- `res/Services/AssessmentService.ts` — removed `createCA`, `createExam`
- `res/controller/admin/AssessmentController.ts` — removed matching controller methods
- `res/routes/admin/admin.js` — removed `POST /ca/create`, `POST /exam/create`

**Why:**  
CAs and Exams are no longer created manually one by one. They are auto-generated when a subject is assigned to a class, using a CA template as the blueprint. A manual creation endpoint is redundant and bypasses the template system.

---

### 4.4 — Fix unique constraint on ContinuousAssessment and Exam

**File changed:** `prisma/schema.prisma`

**Old constraint:**
```prisma
@@unique([createdByAdminId, classId, name])
```

**New constraint:**
```prisma
@@unique([classId, subjectId, name])
```

**Why:**  
The old constraint prevented two CAs with the same name in the same class, even if they belonged to different subjects. This made it impossible to have `CA1` for both Maths and English in the same class. The new constraint correctly allows this as long as the subject is different.

---

### 4.5 — Add CATemplate model

**File changed:** `prisma/schema.prisma`

```prisma
model CATemplate {
  id       Int     @id @default(autoincrement())
  schoolId Int
  classId  Int?
  name     String
  maxScore Int
  isExam   Boolean @default(false)

  school School @relation(fields: [schoolId], references: [id])
  class  Class?  @relation(fields: [classId], references: [id])

  @@unique([schoolId, classId, name])
  @@map("ca_templates")
}
```

**Why:**  
Admin needs a flexible way to define assessment structure without hardcoding it. A `NULL` classId means the template applies school-wide. A set `classId` overrides the school default for that specific class only.

**How it works:**
```
School-wide template:
  CA1 (maxScore: 10), CA2 (maxScore: 10), Final Exam (maxScore: 100)
  → applies to ALL classes unless overridden

Class-specific override (Class 1 only):
  CA1 (maxScore: 20), Final Exam (maxScore: 100)
  → Class 1 uses this instead of the school-wide template
```

---

### 4.6 — Add ClassSubject model

**File changed:** `prisma/schema.prisma`

```prisma
model ClassSubject {
  id        Int @id @default(autoincrement())
  classId   Int
  subjectId Int

  class   Class   @relation(fields: [classId], references: [id])
  subject Subject @relation(fields: [subjectId], references: [id])

  @@unique([classId, subjectId])
  @@map("class_subjects")
}
```

**Why:**  
Establishes a direct, independent relationship between a class and its subjects. This is the trigger point for CA auto-generation. When a subject is assigned to a class via this model, the system uses the relevant CA template to automatically generate the correct CA and Exam records for that subject.

---

### 4.7 — Add PublishedResult and PublishedResultRow models

**File changed:** `prisma/schema.prisma`

```prisma
model PublishedResult {
  id                 Int      @id @default(autoincrement())
  classId            Int
  subjectId          Int
  academicSessionId  Int
  publishedByAdminId Int
  publishedAt        DateTime @default(now())

  class           Class           @relation(fields: [classId], references: [id])
  subject         Subject         @relation(fields: [subjectId], references: [id])
  academicSession AcademicSession @relation(fields: [academicSessionId], references: [id])
  admin           Admin           @relation(fields: [publishedByAdminId], references: [id])
  rows            PublishedResultRow[]

  @@unique([classId, subjectId, academicSessionId])
  @@map("published_results")
}

model PublishedResultRow {
  id                Int     @id @default(autoincrement())
  publishedResultId Int
  studentId         Int
  caTotal           Float
  examTotal         Float
  total             Float
  grade             String?
  remark            String?
  position          Int?

  publishedResult PublishedResult @relation(fields: [publishedResultId], references: [id])
  student         Student         @relation(fields: [studentId], references: [id])

  @@map("published_result_rows")
}
```

**Why:**  
Results are computed live. Once admin publishes, a permanent snapshot is saved to the database. This prevents score changes from affecting already-approved results. Publishing is the admin's act of acceptance — there is no separate accept step.

---

### 4.8 — Add ResultSubmission model

**File changed:** `prisma/schema.prisma`

```prisma
enum SubmissionStatus {
  PENDING
  REJECTED
}

model ResultSubmission {
  id                Int              @id @default(autoincrement())
  classId           Int
  subjectId         Int
  academicSessionId Int
  staffId           Int
  status            SubmissionStatus @default(PENDING)
  submittedAt       DateTime         @default(now())

  class           Class           @relation(fields: [classId], references: [id])
  subject         Subject         @relation(fields: [subjectId], references: [id])
  academicSession AcademicSession @relation(fields: [academicSessionId], references: [id])
  staff           Staff           @relation(fields: [staffId], references: [id])

  @@unique([classId, subjectId, academicSessionId, staffId])
  @@map("result_submissions")
}
```

**Why:**  
Gives teachers a formal step to say "I am done — please review my results." Once submitted, scores are locked. Admin can either publish (permanently locked) or reject (unlocks scores so teacher can fix and resubmit).

---

## 5. Result Status Flow

```
No submission
  → Teacher still entering scores — fully editable

PENDING submission
  → Teacher submitted, awaiting admin review — scores locked

REJECTED
  → Admin sent back for corrections — scores unlocked, teacher can fix and resubmit

PUBLISHED
  → Admin approved and published — permanently locked, visible on record
```

---

## 6. The New Flow

```
SETUP (one time, rarely touched)
  Step 1 → Create campuses
  Step 2 → Create classes

DASHBOARD (admin manages ongoing)
  Step 3 → Create subjects
  Step 4 → Define CA template (school-wide or per class override)
  Step 5 → Assign subjects to class → CAs and Exams auto-generated
  Step 6 → Assign teachers to class + subject

SCORING
  Step 7 → Teachers enter scores per subject
  Step 8 → Teacher submits results for review (scores locked)
  Step 9 → Admin reviews submitted results
           → PUBLISH (accepted) → permanently locked snapshot saved
           → REJECT → scores unlocked, teacher corrects and resubmits

REPORTING
  Step 10 → View per-subject result sheet
  Step 11 → View full broadsheet (all subjects per student, with positions)
```

---

## 7. New DB Structure After Refactor

**CATemplate table:**

| id | schoolId | classId | name       | maxScore | isExam |
|----|----------|---------|------------|----------|--------|
| 1  | 1        | NULL    | CA1        | 10       | false  |
| 2  | 1        | NULL    | CA2        | 10       | false  |
| 3  | 1        | NULL    | Final Exam | 100      | true   |

**ClassSubject table:**

| id | classId | subjectId |
|----|---------|-----------|
| 1  | 1       | 1 (Eng)   |
| 2  | 1       | 2 (Math)  |
| 3  | 1       | 3 (Bio)   |

**ContinuousAssessment table (auto-generated on subject assignment):**

| id | classId | subjectId | name | maxScore |
|----|---------|-----------|------|----------|
| 1  | 1       | 1 (Eng)   | CA1  | 10       |
| 2  | 1       | 1 (Eng)   | CA2  | 10       |
| 3  | 1       | 2 (Math)  | CA1  | 10       |
| 4  | 1       | 2 (Math)  | CA2  | 10       |
| 5  | 1       | 3 (Bio)   | CA1  | 10       |
| 6  | 1       | 3 (Bio)   | CA2  | 10       |

**ResultSubmission table:**

| id | classId | subjectId | academicSessionId | staffId | status  |
|----|---------|-----------|-------------------|---------|---------|
| 1  | 1       | 1         | 1                 | 3       | PENDING |

**PublishedResult table (snapshot on publish):**

| id | classId | subjectId | academicSessionId | publishedByAdminId | publishedAt |
|----|---------|-----------|-------------------|--------------------|-------------|
| 1  | 1       | 1         | 1                 | 1                  | 2026-04-13  |

---

## 8. API Endpoints — Full Reference

### Removed endpoints

| Method | Path | Reason |
|--------|------|--------|
| POST | `/setup/ca` | CA creation moved out of setup |
| PATCH | `/admin/ca/assign-subject` | Redundant with new design |
| PATCH | `/admin/exam/assign-subject` | Redundant with new design |
| PATCH | `/teacher/ca/assign-subject` | Redundant with new design |
| PATCH | `/teacher/exam/assign-subject` | Redundant with new design |
| POST | `/admin/ca/create` | Replaced by auto-generation |
| POST | `/admin/exam/create` | Replaced by auto-generation |

### Active endpoints

| Method | Path | Who | What |
|--------|------|-----|------|
| POST | `/admin/ca-template` | Admin | Define CA structure for school or class |
| POST | `/admin/class-subject/assign` | Admin | Assign subjects to class, auto-generates CAs |
| GET | `/admin/class-subject/:classId` | Admin | Get all subjects for a class |
| GET | `/admin/broadsheet` | Admin | Full broadsheet — all subjects, all students |
| POST | `/admin/results/publish` | Admin | Publish results — accepts submission, locks permanently |
| GET | `/admin/results/submissions` | Admin | View all pending teacher submissions |
| DELETE | `/admin/results/submissions/:id/reject` | Admin | Reject submission — unlocks scores for teacher |
| GET | `/teacher/results` | Teacher | Per-subject computed result sheet |
| GET | `/teacher/broadsheet` | Teacher | Broadsheet for teacher's assigned subjects only |
| POST | `/teacher/results/submit` | Teacher | Submit results for admin review — locks scores |
| POST | `/teacher/scores/ca` | Teacher | Enter CA scores |
| POST | `/teacher/scores/exam` | Teacher | Enter Exam scores |

---

## 9. Build Status

| # | Feature | Status |
|---|---------|--------|
| 1 | Remove CA creation from setup | Done |
| 2 | Fix unique constraint on CA and Exam | Done |
| 3 | CATemplate model + endpoint | Done |
| 4 | ClassSubject model + assign endpoint + CA auto-generation | Done |
| 5 | Get class subjects endpoint | Done |
| 6 | Per-subject computed result sheet | Done |
| 7 | Broadsheet — all subjects per student | Done |
| 8 | Position/ranking via usePosition flag | Done |
| 9 | Result publication — admin publishes snapshot | Done |
| 10 | Result submission — teacher submits for review | Done |
| 11 | Lock results on submission and publication | Done |