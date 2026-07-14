# Shared Database Schema - Multi-Monorepo Documentation

**Database:** MySQL (Shared across all monorepos)  
**Context:** Qalox Backend, Marketer Portal, Super Admin Portal  
**Last Updated:** 2026-07-14

---

## 📋 Overview

All three monorepos share the **same MySQL database** for:
- School and campus management
- User authentication (admins, teachers, students)
- Academic assessments and results
- Token generation for super admin registration

**CRITICAL:** Any changes to shared tables must be coordinated across all repos.

---

## 🔐 Authentication & Token System

### Token Model (tokens table)

```sql
CREATE TABLE tokens (
  id INT PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(255) UNIQUE NOT NULL,
  uniqueKey VARCHAR(255) UNIQUE NOT NULL,     -- TKN-XXXXXX format
  status VARCHAR(50),                          -- 'active' or 'inactive'
  schoolName VARCHAR(255) NOT NULL,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Token Format:** `TKN-XXXXXX` (6 uppercase hex characters)
- Example: `TKN-665E7F`, `TKN-A2B3C1`, `TKN-FF00EE`

**Token Lifecycle:**
1. Super Admin generates token for new super admin via `/api/system-admin/generate-token`
2. Token status = `active`
3. New super admin uses token + email to create account
4. After account creation, token status = `inactive`
5. Cannot reuse inactive tokens

**Used by:** Super Admin Portal (token generation)

---

### Admin Model (admins table)

```sql
CREATE TABLE admins (
  id INT PRIMARY KEY AUTO_INCREMENT,
  schoolId INT,
  campusId INT,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,             -- bcrypt hashed
  steps INT DEFAULT 0,                         -- onboarding progress
  role ENUM('super_admin', 'school_admin'),
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  hasLoggedIn BOOLEAN DEFAULT FALSE,
  
  FOREIGN KEY (schoolId) REFERENCES schools(id),
  FOREIGN KEY (campusId) REFERENCES campuses(id)
);
```

**Roles:**
- `super_admin` - System level, no schoolId/campusId
- `school_admin` - School level, requires schoolId

**Used by:** Qalox (authentication), Marketer Portal (school data access)

---

## 🏢 School & Organization

### School Model (schools table)

```sql
CREATE TABLE schools (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(255) UNIQUE NOT NULL,
  prefix VARCHAR(10) NOT NULL,                -- e.g., "JSS", "PRS"
  logoUrl VARCHAR(255),
  stampUrl VARCHAR(255),
  email VARCHAR(255),
  phoneNumber VARCHAR(50),
  address TEXT,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Prefix Usage:** Used to generate unique student IDs
- Format: `{prefix}-STD-{random}`
- Example: If prefix = "JSS", student ID = "JSS-STD-A1B2C3D4"

**Used by:** All repos (core data)

---

### Campus Model (campuses table)

```sql
CREATE TABLE campuses (
  id INT PRIMARY KEY AUTO_INCREMENT,
  schoolId INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  address TEXT,
  phoneNumber VARCHAR(50),
  email VARCHAR(255),
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (schoolId) REFERENCES schools(id),
  UNIQUE KEY (schoolId, name)
);
```

**Constraint:** Same campus name cannot exist twice per school

**Used by:** Qalox (class & student management), Marketer Portal (location data)

---

## 👥 People Management

### Staff Model (staffs table)

```sql
CREATE TABLE staffs (
  id INT PRIMARY KEY AUTO_INCREMENT,
  schoolId INT NOT NULL,
  campusId INT,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE,
  gender VARCHAR(10),                          -- "Male", "Female", "Other"
  phoneNumber VARCHAR(50),
  address TEXT,
  duty VARCHAR(255),                           -- "Teacher", "Accountant", etc.
  nextOfKin VARCHAR(255),
  dateEmployed DATETIME,
  payroll DECIMAL(10, 2),
  registrationNumber VARCHAR(50) UNIQUE NOT NULL,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (schoolId) REFERENCES schools(id),
  FOREIGN KEY (campusId) REFERENCES campuses(id),
  UNIQUE KEY (schoolId, registrationNumber)
);
```

**registrationNumber:** Unique staff ID per school

**Used by:** Qalox (teacher assignments)

---

### Student Model (students table)

```sql
CREATE TABLE students (
  id INT PRIMARY KEY AUTO_INCREMENT,
  schoolId INT NOT NULL,
  campusId INT,
  classId INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  surname VARCHAR(255) NOT NULL,
  otherNames VARCHAR(255),
  gender VARCHAR(10),
  dateOfBirth VARCHAR(255),
  guardianName VARCHAR(255),
  guardianNumber VARCHAR(255),
  lifestyle VARCHAR(255),
  academicSessionId INT NOT NULL,
  email VARCHAR(255),
  classGroupId INT,
  registrationNumber VARCHAR(50) UNIQUE NOT NULL,  -- e.g., JSS-STD-A1B2C3D4
  passportUrl VARCHAR(255),                         -- Profile image URL
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (schoolId) REFERENCES schools(id),
  FOREIGN KEY (campusId) REFERENCES campuses(id),
  FOREIGN KEY (classId) REFERENCES classes(id),
  FOREIGN KEY (academicSessionId) REFERENCES academic_sessions(id),
  FOREIGN KEY (classGroupId) REFERENCES class_groups(id),
  UNIQUE KEY (schoolId, registrationNumber)
);
```

**Key Fields:**
- `registrationNumber` - Unique student ID (e.g., "JSS-STD-A1B2C3D4")
- `passportUrl` - Profile photo URL
- `academicSessionId` - Current enrollment session

**Used by:** Qalox (assessment), Marketer Portal (student data), Super Admin Portal (reporting)

---

## 🏫 Academic Structure

### Class Model (classes table)

```sql
CREATE TABLE classes (
  id INT PRIMARY KEY AUTO_INCREMENT,
  schoolId INT NOT NULL,
  campusId INT,
  name VARCHAR(255) NOT NULL,                 -- e.g., "JSS 1", "Senior 3B"
  customName VARCHAR(255),
  staffId INT,                                 -- Class teacher
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (schoolId) REFERENCES schools(id),
  FOREIGN KEY (campusId) REFERENCES campuses(id),
  FOREIGN KEY (staffId) REFERENCES staffs(id),
  UNIQUE KEY (name, schoolId, campusId)
);
```

**Constraint:** Same class name cannot exist twice in same school+campus

**Used by:** Qalox (core), Marketer Portal (student lists)

---

### ClassGroup Model (class_groups table)

```sql
CREATE TABLE class_groups (
  id INT PRIMARY KEY AUTO_INCREMENT,
  classId INT NOT NULL,
  name VARCHAR(255) NOT NULL,                 -- e.g., "Science", "Arts"
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (classId) REFERENCES classes(id)
);
```

**Purpose:** Group students within a class (e.g., streams)

**Used by:** Qalox (student grouping)

---

### Subject Model (subjects table)

```sql
CREATE TABLE subjects (
  id INT PRIMARY KEY AUTO_INCREMENT,
  schoolId INT NOT NULL,
  campusId INT,
  name VARCHAR(255) NOT NULL,                 -- e.g., "Mathematics", "English"
  code VARCHAR(50),
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (schoolId) REFERENCES schools(id),
  FOREIGN KEY (campusId) REFERENCES campuses(id)
);
```

**Used by:** Qalox (assessment), Marketer Portal (curriculum)

---

### ClassSubject Model (class_subjects table)

```sql
CREATE TABLE class_subjects (
  id INT PRIMARY KEY AUTO_INCREMENT,
  classId INT NOT NULL,
  subjectId INT NOT NULL,
  
  FOREIGN KEY (classId) REFERENCES classes(id),
  FOREIGN KEY (subjectId) REFERENCES subjects(id),
  UNIQUE KEY (classId, subjectId)
);
```

**Purpose:** Links subjects to classes (many-to-many)

**Used by:** Qalox (assessment generation)

---

### TeacherAssignment Model (teacher_assignments table)

```sql
CREATE TABLE teacher_assignments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  staffId INT NOT NULL,
  classId INT,
  subjectId INT,
  campusId INT,
  assignedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (staffId) REFERENCES staffs(id),
  FOREIGN KEY (classId) REFERENCES classes(id),
  FOREIGN KEY (subjectId) REFERENCES subjects(id),
  FOREIGN KEY (campusId) REFERENCES campuses(id),
  INDEX (staffId, classId, subjectId, campusId)
);
```

**Purpose:** Maps teachers to (class + subject + campus)

**Used by:** Qalox (score entry)

---

## 📊 Assessment & Grading

### CATemplate Model (ca_templates table)

```sql
CREATE TABLE ca_templates (
  id INT PRIMARY KEY AUTO_INCREMENT,
  schoolId INT NOT NULL,
  classId INT,                                 -- NULL = school-wide default
  name VARCHAR(255) NOT NULL,                 -- e.g., "CA1", "CA2", "Exam"
  maxScore INT NOT NULL,
  isExam BOOLEAN DEFAULT FALSE,
  
  FOREIGN KEY (schoolId) REFERENCES schools(id),
  FOREIGN KEY (classId) REFERENCES classes(id),
  UNIQUE KEY (schoolId, classId, name)
);
```

**Purpose:** Defines assessment structure (school-wide or class-specific override)

**Example:**
- School-wide: CA1 (maxScore=10), CA2 (maxScore=10), Exam (maxScore=60)
- Class override: JSS 1 uses different structure

**Used by:** Qalox (auto-generate assessments)

---

### ContinuousAssessment Model (continuous_assessments table)

```sql
CREATE TABLE continuous_assessments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  classId INT NOT NULL,
  subjectId INT NOT NULL,
  name VARCHAR(50) NOT NULL,                  -- e.g., "CA1", "CA2"
  maxScore INT NOT NULL,
  createdByAdminId INT,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (classId) REFERENCES classes(id),
  FOREIGN KEY (subjectId) REFERENCES subjects(id),
  FOREIGN KEY (createdByAdminId) REFERENCES admins(id),
  UNIQUE KEY (classId, subjectId, name)
);
```

**Critical:** Must have subjectId (not NULL)

**Generated by:** When subjects assigned to class

**Used by:** Qalox (score entry)

---

### CAResult Model (ca_results table)

```sql
CREATE TABLE ca_results (
  id INT PRIMARY KEY AUTO_INCREMENT,
  studentId INT,
  caId INT NOT NULL,
  academicSessionId INT NOT NULL,
  termId INT,
  score DECIMAL(10, 2) NOT NULL,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (studentId) REFERENCES students(id),
  FOREIGN KEY (caId) REFERENCES continuous_assessments(id),
  FOREIGN KEY (academicSessionId) REFERENCES academic_sessions(id),
  FOREIGN KEY (termId) REFERENCES academic_terms(id),
  UNIQUE KEY (studentId, caId, academicSessionId)
);
```

**Used by:** Qalox (grade computation)

---

### Exam Model (exams table)

```sql
CREATE TABLE exams (
  id INT PRIMARY KEY AUTO_INCREMENT,
  classId INT NOT NULL,
  subjectId INT NOT NULL,
  name VARCHAR(50) NOT NULL,                  -- e.g., "Midterm", "Final"
  maxScore INT NOT NULL,
  weightage DECIMAL(10, 2),
  scheduledDate DATETIME,
  createdByAdminId INT,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (classId) REFERENCES classes(id),
  FOREIGN KEY (subjectId) REFERENCES subjects(id),
  FOREIGN KEY (createdByAdminId) REFERENCES admins(id),
  UNIQUE KEY (classId, subjectId, name)
);
```

**Used by:** Qalox (score entry)

---

### ExamResult Model (exam_results table)

```sql
CREATE TABLE exam_results (
  id INT PRIMARY KEY AUTO_INCREMENT,
  studentId INT,
  examId INT NOT NULL,
  academicSessionId INT NOT NULL,
  termId INT,
  score DECIMAL(10, 2) NOT NULL,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (studentId) REFERENCES students(id),
  FOREIGN KEY (examId) REFERENCES exams(id),
  FOREIGN KEY (academicSessionId) REFERENCES academic_sessions(id),
  FOREIGN KEY (termId) REFERENCES academic_terms(id),
  UNIQUE KEY (studentId, examId, academicSessionId)
);
```

**Used by:** Qalox (grade computation)

---

### GradingScheme Model (grading_schemes table)

```sql
CREATE TABLE grading_schemes (
  id INT PRIMARY KEY AUTO_INCREMENT,
  schoolId INT NOT NULL,
  campusId INT,
  name VARCHAR(255) NOT NULL,
  usePosition BOOLEAN DEFAULT TRUE,           -- Rank students?
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (schoolId) REFERENCES schools(id),
  FOREIGN KEY (campusId) REFERENCES campuses(id)
);
```

**usePosition:** Controls whether students are ranked (position 1st, 2nd, 3rd)

**Used by:** Qalox (result computation)

---

### GradingRule Model (grading_rules table)

```sql
CREATE TABLE grading_rules (
  id INT PRIMARY KEY AUTO_INCREMENT,
  schemeId INT NOT NULL,
  minScore INT NOT NULL,
  maxScore INT NOT NULL,
  grade VARCHAR(10) NOT NULL,                 -- e.g., "A", "B", "C"
  remark VARCHAR(255),                        -- e.g., "Excellent", "Good"
  
  FOREIGN KEY (schemeId) REFERENCES grading_schemes(id)
);
```

**Example:**
- minScore=90, maxScore=100, grade="A", remark="Excellent"
- minScore=80, maxScore=89, grade="B", remark="Good"
- minScore=0, maxScore=79, grade="C", remark="Needs Improvement"

**Used by:** Qalox (grade assignment)

---

### GradingSchemeClass Model (grading_scheme_classes table)

```sql
CREATE TABLE grading_scheme_classes (
  id INT PRIMARY KEY AUTO_INCREMENT,
  schemeId INT NOT NULL,
  classId INT UNIQUE NOT NULL,
  
  FOREIGN KEY (schemeId) REFERENCES grading_schemes(id),
  FOREIGN KEY (classId) REFERENCES classes(id)
);
```

**Constraint:** One scheme per class (ensures consistency)

**Used by:** Qalox (result computation)

---

### RemarkScheme Model (remark_schemes table)

```sql
CREATE TABLE remark_schemes (
  id INT PRIMARY KEY AUTO_INCREMENT,
  schoolId INT UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (schoolId) REFERENCES schools(id)
);
```

**Purpose:** School-level feedback comments

**Used by:** Qalox (result remarks)

---

### RemarkRule Model (remark_rules table)

```sql
CREATE TABLE remark_rules (
  id INT PRIMARY KEY AUTO_INCREMENT,
  schemeId INT NOT NULL,
  minScore INT NOT NULL,
  maxScore INT NOT NULL,
  remark TEXT NOT NULL,
  
  FOREIGN KEY (schemeId) REFERENCES remark_schemes(id)
);
```

**Used by:** Qalox (verbal feedback)

---

## 📅 Academic Calendar

### AcademicSession Model (academic_sessions table)

```sql
CREATE TABLE academic_sessions (
  id INT PRIMARY KEY AUTO_INCREMENT,
  schoolId INT NOT NULL,
  name VARCHAR(255) NOT NULL,                 -- e.g., "2024/2025", "2025"
  isActive BOOLEAN DEFAULT FALSE,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (schoolId) REFERENCES schools(id),
  UNIQUE KEY (schoolId, name)
);
```

**isActive:** Current session for student enrollment

**Used by:** Qalox (student enrollment), Marketer Portal (current year)

---

### AcademicTerm Model (academic_terms table)

```sql
CREATE TABLE academic_terms (
  id INT PRIMARY KEY AUTO_INCREMENT,
  sessionId INT NOT NULL,
  schoolId INT NOT NULL,
  name VARCHAR(255) NOT NULL,                 -- e.g., "Term 1", "Term 2"
  startDate DATETIME,
  endDate DATETIME,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (sessionId) REFERENCES academic_sessions(id),
  FOREIGN KEY (schoolId) REFERENCES schools(id)
);
```

**Used by:** Qalox (result filtering by term)

---

## 📈 Results & Publishing

### PublishedResult Model (published_results table)

```sql
CREATE TABLE published_results (
  id INT PRIMARY KEY AUTO_INCREMENT,
  classId INT NOT NULL,
  subjectId INT NOT NULL,
  academicSessionId INT NOT NULL,
  termId INT,
  publishedByAdminId INT NOT NULL,
  publishedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (classId) REFERENCES classes(id),
  FOREIGN KEY (subjectId) REFERENCES subjects(id),
  FOREIGN KEY (academicSessionId) REFERENCES academic_sessions(id),
  FOREIGN KEY (termId) REFERENCES academic_terms(id),
  FOREIGN KEY (publishedByAdminId) REFERENCES admins(id),
  UNIQUE KEY (classId, subjectId, academicSessionId)
);
```

**Purpose:** Snapshot of final results (immutable)

**Used by:** Qalox (result publishing)

---

### PublishedResultRow Model (published_result_rows table)

```sql
CREATE TABLE published_result_rows (
  id INT PRIMARY KEY AUTO_INCREMENT,
  resultId INT NOT NULL,
  studentId INT NOT NULL,
  caTotal DECIMAL(10, 2),
  examScore DECIMAL(10, 2),
  finalScore DECIMAL(10, 2),
  grade VARCHAR(10),
  position INT,                               -- Rank (if usePosition=true)
  
  FOREIGN KEY (resultId) REFERENCES published_results(id),
  FOREIGN KEY (studentId) REFERENCES students(id)
);
```

**Contains:** One row per student in published result

**Used by:** Qalox (student results), Marketer Portal (student reports)

---

### ResultSubmission Model (result_submissions table)

```sql
CREATE TABLE result_submissions (
  id INT PRIMARY KEY AUTO_INCREMENT,
  classId INT NOT NULL,
  subjectId INT NOT NULL,
  staffId INT NOT NULL,
  academicSessionId INT NOT NULL,
  submittedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (classId) REFERENCES classes(id),
  FOREIGN KEY (subjectId) REFERENCES subjects(id),
  FOREIGN KEY (staffId) REFERENCES staffs(id),
  FOREIGN KEY (academicSessionId) REFERENCES academic_sessions(id)
);
```

**Purpose:** Audit trail of teacher submissions

**Used by:** Qalox (result locking)

---

## 🔗 Data Sync Rules for Monorepos

### Rule 1: Shared Admin Access
- **Super Admin Portal** creates super_admin accounts
- **Qalox** uses super_admin tokens to create schools
- **Marketer Portal** reads schools for marketing data

### Rule 2: Student Data Consistency
- **Qalox** creates/updates students
- **Marketer Portal** reads student data (read-only)
- **Both use same registrationNumber format:** `{prefix}-STD-{random}`

### Rule 3: Token Generation
- **Qalox** generates tokens in format: `TKN-XXXXXX` (6 hex characters)
- **All repos validate tokens against same tokens table**
- **Lifecycle:** active → inactive (after use)

### Rule 4: Academic Sessions
- **Qalox** creates/manages academic sessions
- **Marketer Portal** reads current session via isActive flag
- **Super Admin Portal** views all sessions across schools

### Rule 5: School Structure
- Schools own campuses, classes, subjects
- All queries must filter by schoolId
- Never assume single-school context

---

## 🚨 Critical Constraints

```sql
-- Email uniqueness across system
ALTER TABLE admins ADD UNIQUE (email);
ALTER TABLE staffs ADD UNIQUE (email);
ALTER TABLE students ADD UNIQUE (registrationNumber) PER SCHOOL;

-- One grading scheme per class
ALTER TABLE grading_scheme_classes ADD UNIQUE (classId);

-- One remark scheme per school
ALTER TABLE remark_schemes ADD UNIQUE (schoolId);

-- CA must have subject (never NULL)
ALTER TABLE continuous_assessments 
  ADD CONSTRAINT ca_subjectid_notnull CHECK (subjectId IS NOT NULL);

-- Exam must have subject (never NULL)
ALTER TABLE exams 
  ADD CONSTRAINT exam_subjectid_notnull CHECK (subjectId IS NOT NULL);
```

---

## 📝 Example: Multi-Repo Data Flow

```
Super Admin Portal (Create)
├─ Generate Token: TKN-A2B3C1
├─ Send to Admin email
└─ Token stored in tokens table (status=active)

                ↓

Qalox Backend (Registration)
├─ Admin uses TKN-A2B3C1 + email
├─ Validate token (find in tokens table)
├─ Create school
├─ Create admin account
└─ Set token status=inactive

                ↓

Qalox Backend (School Setup)
├─ Create campuses
├─ Create classes
├─ Create subjects
├─ Assign teachers
└─ Create grading schemes

                ↓

Marketer Portal (Read)
├─ Query schools (all)
├─ Query students by schoolId
├─ Query classes by schoolId
├─ Query current session (isActive=true)
└─ Generate reports
```

---

## 🔄 Migration & Deployment

**When adding new tables/columns:**
1. Create migration in Qalox: `npm run prisma:migrate`
2. **Notify other repos** of schema changes
3. Other repos run: `npm run prisma:generate`
4. Verify queries still work in other repos

**When changing existing tables:**
1. Coordinate timing across repos
2. Use database transactions
3. Prepare rollback strategy

---

## 📞 Common Queries Across Repos

### Get Active Schools (Marketer Portal)
```sql
SELECT id, name, prefix, email, phoneNumber FROM schools;
```

### Get Students for School (Marketer Portal)
```sql
SELECT 
  id, registrationNumber, name, surname, 
  academicSessionId, classId, email
FROM students
WHERE schoolId = ?
ORDER BY createdAt DESC;
```

### Get Current Academic Session (Marketer Portal)
```sql
SELECT id, name FROM academic_sessions
WHERE schoolId = ? AND isActive = TRUE;
```

### Get Published Results (Marketer Portal)
```sql
SELECT r.*, rr.studentId, rr.finalScore, rr.grade, rr.position
FROM published_results r
JOIN published_result_rows rr ON r.id = rr.resultId
WHERE r.classId = ? AND r.academicSessionId = ?;
```

### Validate Token (All Repos)
```sql
SELECT * FROM tokens
WHERE email = ? AND uniqueKey = ? AND status = 'active';
```

---

## 📖 Version History

| Date | Change | Impact |
|------|--------|--------|
| 2026-07-14 | Token format changed to TKN-XXXXXX | Update token validation |
| 2026-07-14 | Database schema documented | Share with all repos |
| - | - | - |

---

## ✅ Checklist for Integration

- [ ] Update Super Admin Portal token validator to accept `TKN-XXXXXX`
- [ ] Update Marketer Portal to read from shared database
- [ ] Test token generation in Qalox
- [ ] Test student data sync across repos
- [ ] Test academic session filtering in Marketer Portal
- [ ] Document any repo-specific queries
- [ ] Setup shared database backups
- [ ] Create shared database migration script

---

**Questions?** Create issues or DM with schema-related questions. Keep this doc updated as schema evolves!
