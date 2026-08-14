# Qalox Backend — Shared API Contract

**Send this file, unchanged, to every portal team.** It is the single source of
truth for how clients talk to the backend. If something here is wrong, fix it
here first — do not work around it in one portal.

One Express/Prisma backend + **ONE MySQL database** serves all portals. Marketer
Portal, Super Admin Portal, and School Admin Portal are clients of the same
instance. Assume any data you write is immediately visible to the others.

## Base

Local: `http://localhost:3000` — Prod: (Railway URL)
All routes are prefixed `/api`. Swagger: `/docs`, `/docs/school-system`, `/docs/super-admin`

## Route ownership

| Prefix | Portal / consumer |
|---|---|
| `/api/admin/*` | School Admin Portal |
| `/api/teacher/*` | Teacher (school app) |
| `/api/student/*`, `/api/dashboard/*` | Student |
| `/api/parent/*` | Parent |
| `/api/public/*` | Marketer Portal + service-to-service |
| `/api/<root>` | Super Admin Portal — `login`, `stats`, `settings`, `admins`, `billing/*`, `communications`, `notifications`, `analytics/*`, `tokens`, `marketers/stats` |
| `/api/webhooks/flutterwave` | Flutterwave only (HMAC verified) |
| `/api/uploads/*` | static files (logos, passports, stamps) |

> ⚠️ Super Admin routes mount at bare `/api` — e.g. `POST /api/login`,
> `GET /api/stats`. There is no `/superadmin` path segment.

## Response envelope — ALWAYS

```jsonc
// success
{ "success": true, "message": "...", "data": null }
// error
{ "success": false, "message": "...", "code": "OPTIONAL_CODE" }
```

HTTP status carries the real signal. Never parse `message` strings for logic —
use status + `code`. `data` may be `null`, an object, or an array; check per
endpoint.

## Auth

Header: `Authorization: Bearer <jwt>` for all user-facing portals.
Roles are encoded in the JWT payload:

- `admin` / `super_admin` / `school_admin` / `sub_admin`
- `teacher` (carries `staffId`)
- `student`, `parent`

Expiry: teacher & student 1 day, parent 7 days.

### Service-to-service (`/api/public/*`, middleware `serviceAuth`)

- Send **both** `Authorization: Bearer <jwt>` and `x-service-key: <key>`.
- **Bearer is tried FIRST and wins.** It identifies the logged-in user
  (`req.user`). `x-service-key` only proves "a known app is calling" — never
  who. Do not rely on it for user scoping.
- Marketer Portal JWTs are signed with `MARKETER_PORTAL_JWT_SECRET`, a
  **different** secret from the main `JWT_SECRET`. The backend tries
  `JWT_SECRET` first, then falls back.
- An invalid Bearer plus a valid `x-service-key` still passes — but as a
  service, not a user.

## Multi-tenancy — the critical rule

Every school's data is isolated by `schoolId`, which the backend derives from
the token (`attachSchoolId` middleware).

**Never send `schoolId` from the client to select a tenant.** It is ignored or
rejected. Super Admin endpoints are the only ones that operate across schools.

Sub-admins are further restricted by a `permissions` array:

```
overview.view      students.manage   staff.manage      classes.manage
subjects.manage    campuses.manage   results.manage    results.generate
ca_template.manage fees.manage       sms_broadcast.send analytics.view
```

Head admins (`super_admin` / `school_admin`) bypass these entirely. A `403`
means the sub-admin lacks the permission — hide the sidebar module rather than
surfacing an error.

## Shared domain state

All portals read the same records. Order matters — each step gates the next.

**Results lifecycle**

1. Admin creates a `GradingScheme` (score bands + `usePosition`) → assigns it to classes
2. Admin sets up `CATemplate` + `ClassSubject` assignments
3. Teacher enters CA and Exam scores
4. Teacher submits → `ResultSubmission` (`pending`)
5. Admin approves or rejects → Admin publishes
6. `PublishedResult` snapshot — this is what Students and Parents read

A class with **no grading scheme cannot compute a broadsheet** (hard error).
Published results are a frozen snapshot — later score edits do **not** change
them.

**Billing** — `BillingPlan` → `SchoolSubscription` → `SchoolPayment` (Flutterwave).
School-level student fees are separate: `FeeStructure` → `StudentFee` → `Payment`.
`Commission` + `MarketerSchoolLead` drive the marketer referral program.

## CORS (production)

Allowed origins: `app.qalox.net`, `marketer.qalox.net`, `qalox.net`, `admin.qalox.net`
Allowed headers: `Content-Type`, `Authorization`, `x-service-key`
`credentials: false` → use Bearer tokens in headers, **not** cookies.
Localhost is allowed only when `NODE_ENV=development`.

## Gotchas

- Codebase is mixed JS + TS; newer domains (results, grading, auth) are TS classes.
- The server calls `process.exit(1)` if the DB is unreachable — a dead server
  means DB/env trouble, not a bad request.
- File uploads are `multipart/form-data` via multer; images processed with sharp.
