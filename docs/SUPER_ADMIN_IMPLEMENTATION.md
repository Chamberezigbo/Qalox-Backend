# 👑 Super Admin Portal - Implementation Guide

## Overview

The Super Admin Portal has been consolidated into the Qalox Backend. This document outlines the implementation across three phases.

---

## ✅ Phase 1 (COMPLETE) - Critical Endpoints

### What Was Implemented

**4 Core Endpoints** establishing the Super Admin authentication and token management architecture:

#### 1. **POST /api/super-admin/login** (Public)
Authenticate super admin and receive JWT token (24-hour validity)

**Request:**
```json
{
  "email": "super-admin@qalox.com",
  "password": "SuperAdmin123!"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Authentication successful",
  "data": {
    "id": 1,
    "email": "super-admin@qalox.com",
    "name": "Super Administrator",
    "role": "super_admin",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "firstLogin": false
  }
}
```

#### 2. **GET /api/super-admin/profile** (Protected)
Retrieve authenticated super admin's profile

**Authorization:** Bearer JWT Token
**Response:** Admin profile with id, email, name, role, timestamps

#### 3. **POST /api/super-admin/tokens/generate** (Protected)
Generate new registration token for new admin accounts

**Request:**
```json
{
  "email": "newadmin@school.com",
  "schoolName": "St. John Academy"  // optional
}
```

**Response:**
```json
{
  "success": true,
  "message": "Registration token generated successfully",
  "data": {
    "id": 1,
    "email": "newadmin@school.com",
    "token": "TKN-ABC123DEF456",
    "status": "active",
    "schoolName": "St. John Academy",
    "expiresAt": "2026-08-20T10:30:00Z"
  }
}
```

#### 4. **GET /api/super-admin/tokens** (Protected)
List all registration tokens with pagination and filtering

**Query Parameters:**
- `page` (default: 1)
- `limit` (default: 20, max: 100)
- `status` (filter: active, inactive, used)

**Response:**
```json
{
  "success": true,
  "data": {
    "tokens": [
      {
        "id": 1,
        "email": "newadmin@school.com",
        "token": "TKN-ABC123DEF456",
        "status": "active",
        "schoolName": "St. John Academy",
        "createdAt": "2026-07-21T10:30:00Z",
        "expiresAt": "2026-08-20T10:30:00Z",
        "usedAt": null
      }
    ],
    "pagination": {
      "total": 42,
      "page": 1,
      "limit": 20,
      "pages": 3
    }
  }
}
```

---

### Files Created

#### Database Schema
- `prisma/schema.prisma` - Added 3 new models:
  - `SuperAdminToken` - Registration tokens
  - `PlatformSettings` - Platform-wide settings
  - `BillingPlan` - Billing plans

#### Controllers
- `res/controller/superadmin/SuperAdminController.js` - 4 endpoint implementations

#### Middleware
- `res/middleware/authenticateSuperAdminJWT.js` - JWT validation for super admin

#### Routes
- `res/routes/superadmin/superadmin.js` - 4 route definitions

#### Validation Schemas
- `res/schemas/superAdminSchemas.js` - Input validation (email, password, token generation)

#### Documentation
- `docs/openapi-super-admin.yaml` - Complete OpenAPI 3.0 spec (Phase 1)
- Documentation endpoint at `/docs/super-admin`

#### Setup
- `scripts/seed-super-admin.js` - Create default super admin for testing

---

### Security Implementation

✅ **JWT Authentication**
- 24-hour token validity
- Bearer token scheme
- Role validation (super_admin only)

✅ **Password Security**
- bcryptjs hashing (10+ salt rounds)
- Minimum 8 characters required

✅ **Token Generation**
- TKN-XXXXXX format (cryptographically secure)
- 30-day expiration by default
- One active token per email address
- Status tracking (active, inactive, used)

✅ **Input Validation**
- Email format validation
- Password strength validation
- Schema-based validation

---

### Testing & Seeding

**Create default super admin:**
```bash
node scripts/seed-super-admin.js
```

**Credentials:**
- Email: `super-admin@qalox.com`
- Password: `SuperAdmin123!`

**Access Swagger UI:**
- Visit: `http://localhost:3000/docs/super-admin`
- Try the `/login` endpoint first
- Copy the returned token
- Click "Authorize" button and paste: `Bearer <token>`
- Try the protected endpoints

---

## 📋 Phase 2 (Planned) - High Priority

**Timeline:** Week 1-2  
**Endpoints:** 5 new endpoints

### Planned Endpoints

1. **POST /api/super-admin/register**
   - Create new admin using registration token
   - Validate token, create Admin, mark token as used
   - Return JWT token for immediate login

2. **PATCH /api/super-admin/profile**
   - Update admin name, email
   - Validate changes, prevent duplicate emails

3. **PATCH /api/super-admin/change-password**
   - Change admin password
   - Require current password verification
   - Validate new password strength

4. **DELETE /api/super-admin/tokens/:id**
   - Revoke/deactivate registration token
   - Mark as inactive, prevent reuse

5. **GET /api/super-admin/stats**
   - Dashboard statistics
   - Return: token usage, active admins, schools count, etc.

---

## 📋 Phase 3 (Planned) - Medium Priority

**Timeline:** Week 2+  
**Endpoints:** 3 new endpoints

### Planned Endpoints

1. **GET /api/super-admin/settings**
   - Retrieve platform settings
   - Commission rate, token expiration days, max tokens per school

2. **PATCH /api/super-admin/settings**
   - Update platform settings
   - Only super admin can modify

3. **GET /api/super-admin/plans**
   - List all active billing plans (no auth required)
   - Return: plan name, price, features, highlighted flag

---

## 🔄 Database Migration

Run Prisma migration to create new tables:

```bash
# Generate migration files
npx prisma migrate dev --name add_super_admin_tables

# Or directly push schema (development only)
npx prisma db push
```

**New Tables:**
- `super_admin_tokens` - Registration tokens
- `platform_settings` - Platform settings
- `billing_plans` - Billing plans

---

## 📊 Endpoint Summary

| Endpoint | Method | Phase | Status | Auth |
|----------|--------|-------|--------|------|
| `/login` | POST | 1 | ✅ Done | Public |
| `/profile` | GET | 1 | ✅ Done | JWT |
| `/tokens/generate` | POST | 1 | ✅ Done | JWT |
| `/tokens` | GET | 1 | ✅ Done | JWT |
| `/register` | POST | 2 | 📋 Planned | Public |
| `/profile` | PATCH | 2 | 📋 Planned | JWT |
| `/change-password` | PATCH | 2 | 📋 Planned | JWT |
| `/tokens/:id` | DELETE | 2 | 📋 Planned | JWT |
| `/stats` | GET | 2 | 📋 Planned | JWT |
| `/settings` | GET | 3 | 📋 Planned | JWT |
| `/settings` | PATCH | 3 | 📋 Planned | JWT |
| `/plans` | GET | 3 | 📋 Planned | Public |

---

## 🚀 Deployment Checklist

- [ ] Run `npx prisma migrate dev` to create database tables
- [ ] Run `node scripts/seed-super-admin.js` to create default admin
- [ ] Test `/api/super-admin/login` with default credentials
- [ ] Verify JWT token generation
- [ ] Test protected endpoints with JWT token
- [ ] Verify CORS configuration for frontend origin
- [ ] Access Swagger UI at `/docs/super-admin`
- [ ] Change default admin password in production
- [ ] Update CORS_ORIGIN in .env for production domain
- [ ] Set up rate limiting on `/login` endpoint (recommended)

---

## 📖 API Documentation

**Swagger UI:** `http://localhost:3000/docs/super-admin`  
**OpenAPI Spec:** `/api/docs/openapi-super-admin.yaml`  
**Documentation Index:** `/api/docs`

---

## 🔐 CORS Configuration

Update `.env` with your frontend origin:

```env
CORS_ORIGIN="http://localhost:5173,https://super-admin.yourdomain.com"
```

Allow methods: GET, POST, PATCH, DELETE  
Allow headers: Content-Type, Authorization  
Allow credentials: true

---

## 📝 Architecture Notes

### Consolidated Design
- Single authentication system
- Unified database schema
- Consistent error handling
- Shared middleware architecture

### Separation of Concerns
- Super Admin Portal: `/api/super-admin` 
- School System: `/api/admin`
- Marketer Portal: `/api/public`
- Student/Teacher: `/api/student`, `/api/teacher`

### Token Management
- **JWT Tokens:** 24-hour validity, for API authentication
- **Registration Tokens:** 30-day validity, for onboarding new admins
- Separate models, separate expiration logic

---

## ❓ FAQ

**Q: How do I test the endpoints?**  
A: Use Swagger UI at `/docs/super-admin` or curl with Bearer token

**Q: What's the registration token format?**  
A: TKN-XXXXXX where X is random hexadecimal (e.g., TKN-ABC123DEF456)

**Q: Can I have multiple active tokens?**  
A: No, one active token per email. Create new token to revoke the old one.

**Q: What happens when a token expires?**  
A: It becomes inactive automatically. Cannot be used for registration.

**Q: How do I reset a password?**  
A: Use PATCH `/profile/change-password` with current password verification (Phase 2)

---

## 🤝 Integration Points

**Frontend Integration:**
```javascript
// Login
POST /api/super-admin/login
{ email, password }

// Get token from response
token = response.data.token

// Use in subsequent requests
Authorization: Bearer {token}

// Get profile
GET /api/super-admin/profile
```

**Admin Onboarding Flow:**
1. Super admin generates token: POST `/tokens/generate`
2. Send token to new admin (email, Slack, etc.)
3. New admin registers using token: POST `/register` (Phase 2)
4. New admin can now login

---

**Status:** Phase 1 Complete ✅ | Phase 2 Ready to Start 📋

