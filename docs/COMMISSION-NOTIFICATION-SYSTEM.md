# Marketer Commission Notification System

## Overview
Complete end-to-end notification system for marketer commission updates with email alerts, profile exposure, dedicated endpoint, and security audit logging.

## Features Implemented

### 1. ✅ Email Notifications
**When:** Super admin updates a marketer's commission rates  
**What:** Transactional email sent via Resend API

**Example Email:**
```
To: marketer@example.com
Subject: Your Commission Rates Have Been Updated

Hello Ahmed,

Your commission rates have been updated by the Qalox admin team.

Updated Rates:
• New School Registration: 15%
• School Renewal: 9%

These rates will apply to all commissions calculated from this point forward.

If you have any questions, please contact support.

Best regards,
Qalox Team
```

**Implementation:**
- Email sent asynchronously after rate update (doesn't block response)
- Uses `EmailService.sendEmail()` from `/res/Services/EmailService.js`
- Configured with `ResenderAPI_KEY` and `RESEND_FROM_ADDRESS` from `.env`

---

### 2. ✅ Commission Info in Marketer Profile
**Endpoint:** `GET /api/public/profile` (existing endpoint, now enhanced)  
**New Field:** `commission` object with rate breakdown

**Response Example:**
```json
{
  "success": true,
  "data": {
    "id": 42,
    "name": "Ahmed Marketing Ltd",
    "email": "ahmed@example.com",
    "commission": {
      "customNewSchoolRate": 15,
      "customRenewalRate": 9,
      "legacyRate": null,
      "effectiveNewSchoolRate": 15,
      "effectiveRenewalRate": 9
    }
  }
}
```

**Rate Precedence:**
1. Custom override (newSchoolCommissionRate, renewalCommissionRate) ← SET BY SUPER ADMIN
2. Legacy rate (commissionRate) ← BACKWARD COMPATIBILITY
3. Global default (firstPaymentCommissionRate, renewalCommissionRate) ← PLATFORM DEFAULT

---

### 3. ✅ Dedicated Marketer Commission Endpoint
**Path:** `GET /api/public/marketer/commission-rates`  
**Authentication:** Service auth (marketer account)  
**Purpose:** Self-service view of rates with full breakdown

**Response:**
```json
{
  "success": true,
  "data": {
    "marketerId": "42",
    "name": "Ahmed Marketing",
    "email": "ahmed@example.com",
    "customRates": {
      "newSchoolCommissionRate": 15,
      "renewalCommissionRate": 9
    },
    "legacyRate": null,
    "effectiveRates": {
      "newSchoolCommissionRate": 15,
      "renewalCommissionRate": 9
    },
    "platformDefaults": {
      "commissionRate": 10,
      "firstPaymentCommissionRate": 12,
      "renewalCommissionRate": 8
    }
  }
}
```

**Use Case:** Marketer can verify their actual commission rates at any time.

---

### 4. ✅ Security Audit Logging
**Event Type:** `marketer_commission_override_changed` | `marketer_commission_override_deleted`  
**Storage:** `SecurityEvent` table in database  
**Logged On:** All commission updates and deletions

**Audit Log Example:**
```
event: "marketer_commission_override_changed"
detail: "by admin 5: renewal: 8 -> 9%; new-school: not set -> 15%"
ipAddress: "192.168.1.1"
userAgent: "Mozilla/5.0..."
createdAt: "2024-01-15T10:30:00Z"
```

---

## API Reference

### Super Admin: Update Commission Rate
```
POST /api/public/settings/marketer-commissions
Authorization: Bearer <service_auth_key>
X-Platform-SuperAdmin: true

{
  "marketerId": 42,
  "newSchoolCommissionRate": 15,
  "renewalCommissionRate": 9
}

Response:
{
  "success": true,
  "data": {
    "marketerId": "42",
    "newSchoolCommissionRate": 15,
    "renewalCommissionRate": 9,
    "updatedAt": "2024-01-15T10:30:00Z"
  }
}
```

**Side Effects:**
- Email notification sent to marketer
- Security event created in audit log
- Marketer's profile now shows new rates

---

### Super Admin: Get Marketer's Rate Breakdown
```
GET /api/superadmin/settings/marketer-commissions/42/rates
Authorization: Bearer <superadmin_jwt_token>

Response: Same as /api/public/marketer/commission-rates
Shows what the marketer sees in their dashboard.
```

---

### Super Admin: Clear Commission Override
```
DELETE /api/public/settings/marketer-commissions/42
Authorization: Bearer <service_auth_key>
X-Platform-SuperAdmin: true

Response:
{
  "success": true,
  "message": "Marketer commission settings cleared"
}
```

**Side Effects:**
- Custom rates cleared (null)
- Marketer reverts to legacy/global default rates
- Security event logged

---

### Marketer: Check Own Rates
```
GET /api/public/marketer/commission-rates
Authorization: Bearer <service_auth_key>
(marketer account authenticated)

Response: Full commission rate breakdown with platform defaults
```

---

## Database Changes

### Admin Table
```sql
ALTER TABLE admins ADD COLUMN newSchoolCommissionRate DOUBLE NULL;
ALTER TABLE admins ADD COLUMN renewalCommissionRate DOUBLE NULL;
```

### SecurityEvent Table (already exists)
Used to log all commission changes with:
- `event`: "marketer_commission_override_changed" | "marketer_commission_override_deleted"
- `detail`: Human-readable description of the change
- `adminId`: Marketer ID
- `ipAddress`: Request IP
- `userAgent`: Browser info

---

## Code Changes

### Modified Files
1. **res/controller/public/publicController.js**
   - `updateMarketerCommission()` → Added email + security logging
   - `getMarketerProfile()` → Added `commission` object
   - `deleteMarketerCommission()` → Added security logging
   - `getMarketerCommissionRates()` → NEW endpoint handler

2. **res/routes/publicAPI.js**
   - Added: `GET /marketer/commission-rates` route

3. **res/routes/superadmin/superadmin.js**
   - Added: `GET /settings/marketer-commissions/:marketerId/rates` route

---

## Email Configuration

Already configured in `.env`:
```
ResenderAPI_KEY=re_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
RESEND_FROM_ADDRESS=Qalox <alerts@noreply.qalox.net>
```

No SMTP server needed. Email uses Resend API (transactional email service).

**To test email delivery:**
1. Update a marketer's commission via API
2. Check marketer's email inbox (may take 1-2 seconds)
3. Email will come from: `Qalox <alerts@noreply.qalox.net>`

---

## Testing

Run unit tests:
```bash
npm test -- res/__tests__/commission-notification.test.ts
```

**15 tests covering:**
- ✅ Rate precedence logic (custom > legacy > global)
- ✅ Email HTML formatting
- ✅ Security event detail strings
- ✅ Effective rate calculation
- ✅ Profile exposure scenarios

All tests pass ✅

---

## Transaction Safety

All commission changes are wrapped in database transactions:
```javascript
await prisma.$transaction([
  prisma.admin.update(...),           // Update rates
  prisma.securityEvent.create(...)    // Log event
], TX_OPTIONS);
```

If either operation fails, both are rolled back. No partial updates.

---

## Frontend Integration Checklist

- [ ] Marketer dashboard: Call `GET /api/public/marketer/commission-rates` to display rate breakdown
- [ ] Marketer inbox: Check for email notifications when rates change
- [ ] Super admin panel: Show audit log from `SecurityEvent` table
- [ ] Super admin panel: Display confirmation modal before updating rates

---

## Log Messages

Watch server logs for:
```
[MARKETER_COMMISSION] Updated custom commission override
[MARKETER_COMMISSION] Email notification failed (check credentials)
[MARKETER_COMMISSION] Cleared custom commission override
[MARKETER_COMMISSION_RATES] Fetched for marketer
```

---

## Key Points

1. **No SMTP setup needed** - Resend API handles all email delivery
2. **Rates are cached during request** - Use `selectMarketerCommissionRate()` function
3. **Email is non-blocking** - Returns response before email sent (fire-and-forget)
4. **Transactions ensure consistency** - Updates and logs always both succeed or both fail
5. **Backward compatible** - Existing rate selection logic unchanged
6. **Audit trail is immutable** - SecurityEvent records cannot be edited

---

## Production Checklist

- [ ] Test email delivery with real marketer email addresses
- [ ] Set up alerting on `[MARKETER_COMMISSION] Email notification failed`
- [ ] Monitor `SecurityEvent` table for suspicious patterns
- [ ] Set up marketer dashboard to show commission rates
- [ ] Test API with different marketer permission levels
- [ ] Verify email headers/body in production (may differ from dev)
