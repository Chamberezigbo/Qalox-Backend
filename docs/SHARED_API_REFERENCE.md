# Shared API Reference - For Other Monorepos

**For:** Marketer Portal & Super Admin Portal  
**Purpose:** APIs to integrate with Qalox backend  
**Base URL:** `http://localhost:3000/api` (adjust for production)

---

## 🔐 Authentication Endpoints

### Super Admin Registration (from Super Admin Portal)

**Endpoint:** `POST /admin/create`

```bash
curl -X POST http://localhost:3000/api/admin/create \
  -H "Content-Type: application/json" \
  -d '{
    "email": "superadmin@example.com",
    "password": "secure_password",
    "name": "Super Admin",
    "role": "super_admin",
    "uniqueKey": "TKN-665E7F"
  }'
```

**Response (201):**
```json
{
  "success": true,
  "message": "Admin created successfully",
  "admin": {
    "id": 1,
    "email": "superadmin@example.com",
    "role": "super_admin",
    "name": "Super Admin",
    "createdAt": "2026-07-14T10:30:00Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Validation:**
- Token must exist in tokens table with status='active'
- Email must match token email
- Password will be bcrypt hashed

---

### Admin Login (School Admin)

**Endpoint:** `POST /admin/login`

```bash
curl -X POST http://localhost:3000/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@school.com",
    "password": "password123"
  }'
```

**Response (200):**
```json
{
  "success": true,
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "admin": {
    "id": 2,
    "email": "admin@school.com",
    "schoolId": 1,
    "role": "school_admin",
    "name": "School Admin"
  }
}
```

---

## 📊 Data Query Endpoints (For Marketer Portal)

### Get All Schools

**Endpoint:** `GET /admin/schools`  
**Auth:** Admin JWT required  
**Query Params:** None

```bash
curl -X GET http://localhost:3000/api/admin/schools \
  -H "Authorization: Bearer <token>"
```

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Jalingo Secondary School",
      "prefix": "JSS",
      "email": "info@jss.edu.ng",
      "phoneNumber": "+234-800-xxx-xxxx",
      "address": "Jalingo, Taraba",
      "logoUrl": "http://...",
      "stampUrl": "http://...",
      "createdAt": "2024-01-15T10:30:00Z"
    }
  ]
}
```

---

### Get Students by School

**Endpoint:** `GET /admin/students`  
**Auth:** Admin JWT required  
**Query Params:**
- `page` (default: 1)
- `schoolId` (required, or use token's schoolId)
- `campusId` (optional)
- `classId` (optional)
- `name` (optional, search)
- `gender` (optional)

```bash
curl -X GET "http://localhost:3000/api/admin/students?schoolId=1&page=1&classId=5" \
  -H "Authorization: Bearer <token>"
```

**Response (200):**
```json
{
  "success": true,
  "students": [
    {
      "id": 1,
      "registrationNumber": "JSS-STD-A1B2C3D4",
      "name": "John",
      "surname": "Doe",
      "otherNames": "Michael",
      "email": "john@example.com",
      "gender": "Male",
      "dateOfBirth": "2009-05-15",
      "classId": 5,
      "academicSessionId": 1,
      "academicSession": {
        "id": 1,
        "name": "2024/2025",
        "isActive": true
      },
      "class": {
        "id": 5,
        "name": "JSS 1A"
      },
      "passportUrl": "http://...",
      "createdAt": "2024-01-15T10:30:00Z"
    }
  ],
  "meta": {
    "total": 150,
    "page": 1,
    "pageSize": 9,
    "totalPages": 17
  }
}
```

---

### Get Single Student

**Endpoint:** `GET /admin/student/:studentId`  
**Auth:** Admin JWT required

```bash
curl -X GET http://localhost:3000/api/admin/student/1 \
  -H "Authorization: Bearer <token>"
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "registrationNumber": "JSS-STD-A1B2C3D4",
    "name": "John",
    "surname": "Doe",
    "otherNames": "Michael",
    "email": "john@example.com",
    "classId": 5,
    "academicSessionId": 1,
    "academicSession": {
      "id": 1,
      "name": "2024/2025",
      "isActive": true
    },
    "campus": {
      "id": 1,
      "name": "Main Campus"
    },
    "classGroup": {
      "id": 1,
      "name": "Science"
    },
    "passportUrl": "http://...",
    "createdAt": "2024-01-15T10:30:00Z"
  }
}
```

---

### Get Classes by School

**Endpoint:** `GET /admin/classes`  
**Auth:** Admin JWT required  
**Query Params:**
- `schoolId` (required)
- `campusId` (optional)

```bash
curl -X GET "http://localhost:3000/api/admin/classes?schoolId=1" \
  -H "Authorization: Bearer <token>"
```

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 5,
      "name": "JSS 1A",
      "customName": "Basic 1A",
      "schoolId": 1,
      "campusId": 1,
      "staffId": 10,
      "createdAt": "2024-01-15T10:30:00Z"
    }
  ]
}
```

---

### Get Academic Sessions

**Endpoint:** `GET /admin/academic-sessions`  
**Auth:** Admin JWT required  
**Query Params:**
- `schoolId` (required)

```bash
curl -X GET "http://localhost:3000/api/admin/academic-sessions?schoolId=1" \
  -H "Authorization: Bearer <token>"
```

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "schoolId": 1,
      "name": "2024/2025",
      "isActive": true,
      "createdAt": "2024-01-15T10:30:00Z"
    },
    {
      "id": 2,
      "schoolId": 1,
      "name": "2023/2024",
      "isActive": false,
      "createdAt": "2023-01-15T10:30:00Z"
    }
  ]
}
```

---

### Get Published Results (for Student Reports)

**Endpoint:** `GET /teacher/results/broadsheet`  
**Auth:** Admin JWT required  
**Query Params:**
- `classId` (required)
- `academicSessionId` (required or uses active)
- `subjectId` (optional, all if not provided)

```bash
curl -X GET "http://localhost:3000/api/teacher/results/broadsheet?classId=5&academicSessionId=1" \
  -H "Authorization: Bearer <token>"
```

**Response (200):**
```json
{
  "success": true,
  "message": "Broadsheet computed successfully",
  "data": {
    "classId": 5,
    "className": "JSS 1A",
    "academicSessionId": 1,
    "sessionName": "2024/2025",
    "publishedAt": "2024-06-15T10:30:00Z",
    "students": [
      {
        "studentId": 1,
        "registrationNumber": "JSS-STD-A1B2C3D4",
        "name": "John Doe",
        "subjects": [
          {
            "subjectId": 1,
            "subjectName": "Mathematics",
            "caScore": 8,
            "caMaxScore": 10,
            "examScore": 45,
            "examMaxScore": 60,
            "totalScore": 53,
            "grade": "B",
            "remark": "Good"
          },
          {
            "subjectId": 2,
            "subjectName": "English",
            "caScore": 9,
            "caMaxScore": 10,
            "examScore": 50,
            "examMaxScore": 60,
            "totalScore": 59,
            "grade": "A",
            "remark": "Excellent"
          }
        ],
        "totalAllSubjects": 112,
        "averageScore": 56,
        "position": 3,
        "positionText": "3rd"
      }
    ]
  }
}
```

---

### Get Student Results (Student Portal)

**Endpoint:** `GET /dashboard/student/results`  
**Auth:** Student JWT required  
**Query Params:**
- `academicSessionId` (optional, uses active)
- `termId` (optional)

```bash
curl -X GET "http://localhost:3000/api/dashboard/student/results" \
  -H "Authorization: Bearer <student_token>"
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "studentId": 1,
    "registrationNumber": "JSS-STD-A1B2C3D4",
    "name": "John Doe",
    "className": "JSS 1A",
    "academicSessionId": 1,
    "sessionName": "2024/2025",
    "results": [
      {
        "subjectId": 1,
        "subjectName": "Mathematics",
        "caScore": 8,
        "examScore": 45,
        "totalScore": 53,
        "grade": "B",
        "remark": "Good",
        "position": 5,
        "classTotal": 42
      }
    ]
  }
}
```

---

### Get Student Metrics Dashboard

**Endpoint:** `GET /dashboard/student/metrics`  
**Auth:** Student JWT required

```bash
curl -X GET http://localhost:3000/api/dashboard/student/metrics \
  -H "Authorization: Bearer <student_token>"
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "studentId": 1,
    "registrationNumber": "JSS-STD-A1B2C3D4",
    "name": "John Doe",
    "currentSession": {
      "id": 1,
      "name": "2024/2025",
      "isActive": true
    },
    "currentClass": {
      "id": 5,
      "name": "JSS 1A"
    },
    "statistics": {
      "totalSubjects": 9,
      "averageScore": 56,
      "gradeDistribution": {
        "A": 2,
        "B": 4,
        "C": 2,
        "D": 1
      },
      "strongestSubjects": ["English", "Biology"],
      "weakestSubjects": ["Mathematics", "Physics"]
    },
    "recentResults": [
      {
        "sessionName": "2024/2025",
        "subjectName": "Mathematics",
        "finalScore": 53,
        "grade": "B",
        "position": 5
      }
    ]
  }
}
```

---

## 🔑 Token Generation (Super Admin Portal)

### Generate Registration Token

**Endpoint:** `POST /system-admin/generate-token`  
**Auth:** Super Admin JWT required

```bash
curl -X POST http://localhost:3000/api/system-admin/generate-token \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <super_admin_token>" \
  -d '{
    "email": "newadmin@school.com",
    "schoolName": "New School"
  }'
```

**Response (201):**
```json
{
  "message": "Token generated successfully",
  "token": "TKN-665E7F"
}
```

**Token Format:** `TKN-XXXXXX` (6 uppercase hex characters)

**Duplicate Request:**
```json
{
  "message": "A token for this email has been taken",
  "token": "TKN-665E7F"
}
```

---

## 🚨 Error Responses

### 400 Bad Request

```json
{
  "success": false,
  "message": "Validation error",
  "errors": [
    {
      "field": "email",
      "message": "Email is required"
    }
  ]
}
```

### 401 Unauthorized

```json
{
  "success": false,
  "message": "Invalid or missing token"
}
```

### 403 Forbidden

```json
{
  "success": false,
  "message": "You do not have permission to access this resource"
}
```

### 404 Not Found

```json
{
  "success": false,
  "message": "Resource not found"
}
```

### 409 Conflict

```json
{
  "success": false,
  "message": "Email already exists",
  "token": "TKN-665E7F"
}
```

### 500 Server Error

```json
{
  "success": false,
  "message": "Internal server error"
}
```

---

## 🔄 Request/Response Format

### Headers (All Requests)

```
Content-Type: application/json
Authorization: Bearer <jwt_token>  (for protected endpoints)
```

### JWT Token Structure

```
Header: {
  "alg": "HS256",
  "typ": "JWT"
}

Payload: {
  "id": 1,
  "email": "admin@school.com",
  "schoolId": 1,
  "role": "school_admin",
  "iat": 1720000000,
  "exp": 1720086400
}

Secret: process.env.JWT_SECRET
```

**Token Lifetime:** 24 hours (configurable via env)

---

## 🗂️ Pagination

For list endpoints (students, classes, etc.):

**Request:**
```
GET /admin/students?page=2&schoolId=1
```

**Response:**
```json
{
  "students": [...],
  "meta": {
    "total": 150,
    "page": 2,
    "pageSize": 9,
    "totalPages": 17
  }
}
```

- Default `pageSize`: 9 items per page
- Default `page`: 1
- Adjust page size via endpoint (if supported)

---

## 💾 Database Sync

### Direct Database Access (For Marketer Portal - Read Only)

If using direct database connections:

```sql
-- Current Academic Session
SELECT * FROM academic_sessions 
WHERE schoolId = ? AND isActive = TRUE;

-- Students in School
SELECT * FROM students 
WHERE schoolId = ? 
ORDER BY createdAt DESC;

-- Published Results
SELECT r.*, rr.* 
FROM published_results r
JOIN published_result_rows rr ON r.id = rr.resultId
WHERE r.classId = ? AND r.academicSessionId = ?;

-- Grading Scheme (for grade display)
SELECT gr.* FROM grading_rules gr
JOIN grading_schemes gs ON gr.schemeId = gs.id
JOIN grading_scheme_classes gsc ON gs.id = gsc.schemeId
WHERE gsc.classId = ?;
```

---

## 📝 Examples by Use Case

### Use Case: Marketer Portal - Show School Dashboard

```javascript
// 1. Get active school
const school = await getSchools();

// 2. Get current session
const session = await getAcademicSessions(schoolId);

// 3. Get student count
const students = await getStudents(schoolId, { page: 1 });

// 4. Get classes
const classes = await getClasses(schoolId);

// Display: School name, students count, current session, class list
```

### Use Case: Student Portal - Show Results

```javascript
// 1. Get current session
const session = await getStudentSessions();

// 2. Get results for session
const results = await getStudentResults(sessionId);

// 3. Get metrics dashboard
const metrics = await getStudentMetrics();

// Display: Results table, performance chart, metrics
```

### Use Case: Admin Portal - Generate Token

```javascript
// Super Admin generates token for new school admin
const token = await generateToken({
  email: "admin@newschool.com",
  schoolName: "New Secondary School"
});

// Send token to admin email
// Admin uses token + email to register
```

---

**Keep endpoints updated as APIs evolve!**
