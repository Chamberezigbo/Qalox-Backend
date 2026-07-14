# Multi-Monorepo Synchronization Guide

**For:** Marketer Portal & Super Admin Portal Developers  
**Purpose:** Understand Qalox database schema and maintain data sync  
**Database:** Shared MySQL (all repos use same DB)

---

## 🎯 Quick Start - Copy This Prompt

Use this when discussing the shared database:

---

### **PROMPT FOR OTHER TEAMS:**

```
We have three monorepos sharing the same MySQL database:

1. **Qalox Backend** (Assessment Management)
   - Manages schools, students, classes, subjects
   - Handles academic assessments (CAs, Exams)
   - Computes grades and publishes results
   - Generates tokens: TKN-XXXXXX (6 hex chars, uppercase)

2. **Marketer Portal** (School Data & Reporting)
   - Reads schools, students, classes
   - Views published results and reports
   - Uses current academic session (isActive=TRUE)
   - Read-only access recommended

3. **Super Admin Portal** (System Administration)
   - Creates super_admin accounts
   - Generates registration tokens (TKN-XXXXXX)
   - Views all schools across system
   - Manages system-level configuration

**CRITICAL DATA RELATIONSHIPS:**

School
  ├─ Campuses
  ├─ Classes
  ├─ Students
  ├─ Subjects
  ├─ Staff (Teachers)
  ├─ AcademicSessions (current: isActive=TRUE)
  │   └─ AcademicTerms
  ├─ GradingSchemes (1 per class)
  │   └─ GradingRules
  └─ ContinuousAssessments & Exams
      ├─ One per (class, subject, name)
      ├─ Must have subjectId (never NULL)
      └─ CAResult & ExamResult (student scores)

**KEY TABLES TO SYNC:**

1. tokens - Registration tokens (TKN-XXXXXX format)
2. admins - Admin users (role: super_admin or school_admin)
3. schools - Organization (name, prefix, email)
4. campuses - School branches
5. students - Enrolled students (registrationNumber format: {prefix}-STD-{random})
6. classes - Class definitions
7. subjects - Course subjects
8. staffs - Teachers and staff
9. academicSessions - Year (isActive flag for current year)
10. academicTerms - Semester/Term within session
11. continuousAssessments - CA definitions (per subject per class)
12. exams - Exam definitions (per subject per class)
13. gradingSchemes - Grade scales (A=90-100, B=80-89, etc.)
14. publishedResults - Final published results (immutable snapshots)

**TOKEN VALIDATION (for ALL repos):**

```sql
SELECT * FROM tokens
WHERE email = ? 
  AND uniqueKey = ? 
  AND status = 'active';
```

Token format: TKN-XXXXXX
- Example: TKN-665E7F, TKN-A2B3C1, TKN-FF00EE
- Length: 6 uppercase hex characters
- Lifecycle: active → inactive (after super admin account creation)

**STUDENT ID FORMAT (DO NOT CHANGE):**

registrationNumber = {SchoolPrefix}-STD-{Random}
- School prefix from schools.prefix (e.g., "JSS", "PRS")
- Format: "JSS-STD-A1B2C3D4"
- Must be unique per school
- Used across all reports and exports

**CURRENT SESSION QUERY (for Marketer Portal):**

```sql
SELECT id, name, isActive 
FROM academic_sessions
WHERE schoolId = ? AND isActive = TRUE;
```

Only ONE active session per school at a time.

**MULTI-TENANCY RULE (CRITICAL):**

Every query MUST filter by schoolId:
```sql
SELECT * FROM students WHERE schoolId = ?;
SELECT * FROM classes WHERE schoolId = ?;
SELECT * FROM subjects WHERE schoolId = ?;
```

Never assume single-school context.

**GRADING SCHEME CONSISTENCY:**

Each class assigned to exactly ONE grading scheme:
```sql
SELECT gs.id, gs.usePosition, gr.minScore, gr.maxScore, gr.grade
FROM grading_schemes gs
JOIN grading_scheme_classes gsc ON gs.id = gsc.schemeId
JOIN grading_rules gr ON gs.id = gr.schemeId
WHERE gsc.classId = ?;
```

If usePosition=TRUE, students are ranked (1st, 2nd, 3rd, etc.)
If usePosition=FALSE, no ranking (just grades).

**PUBLISHED RESULTS (Immutable):**

Results locked after publication (cannot edit):
```sql
SELECT r.*, rr.studentId, rr.caTotal, rr.examScore, rr.finalScore, rr.grade
FROM published_results r
JOIN published_result_rows rr ON r.id = rr.resultId
WHERE r.classId = ? AND r.academicSessionId = ?;
```

Contains computed grades and rankings (if applicable).

**SCHEMA MIGRATION RULES:**

- Qalox makes schema changes → other repos must regenerate Prisma client
- Command: npm run prisma:generate (after schema updated)
- Never hardcode column names (use ORM/schema validation)
- Coordinate deployment timing across repos

**THINGS TO AVOID:**

❌ Don't create students without registrationNumber
❌ Don't create CAs/Exams without subjectId
❌ Don't assign two grading schemes to same class
❌ Don't create admin without schoolId (for school_admin role)
❌ Don't query without schoolId filter
❌ Don't reuse inactive tokens
❌ Don't edit published results (they're immutable)

**FILES TO REFERENCE:**

- docs/SHARED_DATABASE_SCHEMA.md - Complete schema reference
- prisma/schema.prisma - Source of truth
- DECISIONS.md - Why design choices were made
- docs/assessment-refactor.md - Why CAs must have subjects
```

---

## 📋 Table by Table Quick Reference

### tokens
**Purpose:** Registration tokens for super admin creation  
**Key Fields:** email, uniqueKey (TKN-XXXXXX), status, schoolName  
**Created by:** Super Admin Portal  
**Used by:** Qalox (validation during registration)  

### admins
**Purpose:** Admin user accounts  
**Key Fields:** email, password (bcrypt), role (super_admin or school_admin), schoolId  
**Constraint:** Email unique across system  
**Created by:** Qalox (with valid token)  

### schools
**Purpose:** Organization entity  
**Key Fields:** name (unique), prefix (e.g., "JSS"), logoUrl, email  
**Used by:** All repos  

### students
**Purpose:** Student enrollment records  
**Key Fields:** registrationNumber (unique per school), name, surname, classId, academicSessionId, passportUrl  
**Format:** registrationNumber = {prefix}-STD-{random}  
**Created by:** Qalox (during enrollment)  
**Read by:** Marketer Portal (reports)  

### academicSessions
**Purpose:** Academic year (e.g., 2024/2025)  
**Key Fields:** name, isActive, schoolId  
**Constraint:** One active session per school  
**Used by:** All repos (current year reference)  

### classes
**Purpose:** Class definition  
**Key Fields:** name, schoolId, campusId, staffId (teacher)  
**Constraint:** Unique (name, schoolId, campusId)  

### subjects
**Purpose:** Course subject  
**Key Fields:** name, code, schoolId, campusId  

### continuousAssessments
**Purpose:** CA definition (per subject per class)  
**Key Fields:** name, classId, **subjectId** (CRITICAL - never NULL), maxScore  
**Constraint:** Unique (classId, subjectId, name)  

### exams
**Purpose:** Exam definition (per subject per class)  
**Key Fields:** name, classId, **subjectId** (CRITICAL - never NULL), maxScore, weightage  
**Constraint:** Unique (classId, subjectId, name)  

### caResults & examResults
**Purpose:** Student scores  
**Key Fields:** studentId, caId/examId, score, academicSessionId, termId  

### gradingSchemes
**Purpose:** Grade scale definition  
**Key Fields:** name, usePosition (ranking flag), schoolId, campusId  

### gradeRules
**Purpose:** Grade breakpoints  
**Key Fields:** minScore, maxScore, grade ("A"/"B"/"C"), remark  

### publishedResults & publishedResultRows
**Purpose:** Final results (immutable snapshot)  
**Key Fields:** classId, subjectId, academicSessionId (one per combo)  
**Rows:** One per student (caTotal, examScore, finalScore, grade, position)  
**Read by:** Marketer Portal (student reports)  

---

## 🔄 Data Flow Between Repos

```
Super Admin Portal
  ├─ Generates Token (TKN-XXXXXX)
  └─ Stores in tokens table

                ↓

Qalox Backend
  ├─ Admin registers with Token + email
  ├─ Validates token (active, matching email)
  ├─ Creates school, campuses, classes
  ├─ Creates/updates students
  ├─ Creates assessments (CAs, Exams)
  ├─ Teachers enter scores
  ├─ System computes grades
  └─ Publishes results

                ↓

Marketer Portal
  ├─ Reads schools
  ├─ Reads students (by schoolId)
  ├─ Reads current session (isActive=TRUE)
  ├─ Reads published results
  └─ Generates reports
```

---

## ✅ Integration Checklist

For **Super Admin Portal:**
- [ ] Update token validator: accept `TKN-XXXXXX` format
- [ ] Query tokens table for registration validation
- [ ] Test token generation (should produce `TKN-XXXXXX`)
- [ ] Mark token as inactive after account creation

For **Marketer Portal:**
- [ ] Query schools table (all)
- [ ] Query students with schoolId filter (must have)
- [ ] Query academicSessions with schoolId filter
- [ ] Query publishedResults for student reports
- [ ] Never edit data (read-only recommended)
- [ ] Cache current session (isActive=TRUE) per school
- [ ] Use registrationNumber in student exports (not id)

For **All Repos:**
- [ ] Update database connection to shared MySQL instance
- [ ] Test Prisma client generation
- [ ] Verify foreign key relationships work
- [ ] Setup transaction handling for multi-step operations
- [ ] Document any custom queries not in ORM
- [ ] Test schema changes in development first

---

## 🚨 Common Issues & Solutions

**Issue:** "Token not found" error  
**Solution:** Check token status is 'active' and email matches  

**Issue:** Student registration number conflicts  
**Solution:** Ensure prefix is unique per school, use {prefix}-STD-{random}  

**Issue:** Multiple grading schemes for same class  
**Solution:** Delete old scheme first, then assign new one (unique constraint)  

**Issue:** CA/Exam without subject (NULL subjectId)  
**Solution:** Never create without subjectId, always assign subject first  

**Issue:** Multi-tenancy data leaks  
**Solution:** ALWAYS add schoolId to WHERE clause, never skip  

---

## 📞 When to Reach Out

- Schema changes needed → Coordinate with Qalox team
- Token format question → Check TKN-XXXXXX format examples
- Student data sync issue → Verify registrationNumber format
- Academic session logic → Current session has isActive=TRUE
- Grading/results question → Check GradingScheme.usePosition flag

---

**Keep this document updated as schema evolves!**
