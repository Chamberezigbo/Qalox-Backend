# Qalox Marketer Portal - Complete Endpoint Reference

## 📋 Table of Contents
- [Overview](#overview)
- [Authentication](#authentication)
- [Phase 1: Core Features (8 endpoints)](#phase-1-core-features)
- [Phase 2: Profile & Settings (10 endpoints)](#phase-2-profile--settings)
- [Phase 3: Advanced Features (10 endpoints)](#phase-3-advanced-features)
- [Error Codes](#error-codes)
- [Examples](#examples)

---

## Overview

**Base URL:** `http://localhost:3000/api/public`

**Total Endpoints:** 28

**Documentation:**
- OpenAPI Spec: `docs/openapi.yaml`
- Swagger UI: Open `docs/swagger-ui.html` in browser
- This Reference: `docs/ENDPOINT_REFERENCE.md`

---

## Authentication

All endpoints require the `x-service-key` header for service-to-service authentication.

```bash
curl -H "x-service-key: your-service-key" \
  http://localhost:3000/api/public/commissions/summary?marketerId=1
```

---

## Phase 1: Core Features

### 1. POST /auth/2fa/verify
**Verify 2FA code during login**

**Request:**
```bash
POST /auth/2fa/verify
Content-Type: application/json

{
  "tempToken": "eyJhbGciOiJIUzI1NiIs...",
  "code": "123456"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "2FA verified",
  "data": {
    "id": 1,
    "email": "marketer@example.com",
    "name": "John Marketer",
    "role": "marketer",
    "tier": "bronze",
    "token": "eyJhbGciOiJIUzI1NiIs..."
  }
}
```

**Error Codes:**
- `400` - Missing tempToken or code
- `401` - Invalid or expired token
- `401` - Token is not a 2FA temp token
- `401` - Temp token expired
- `404` - Marketer not found

---

### 2. POST /marketers/{marketerId}/wallet
**Perform wallet operation (withdraw/credit)**

**Request:**
```bash
POST /marketers/1/wallet
Content-Type: application/json

{
  "amount": 10000,
  "operation": "withdraw"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Withdrawal processed",
  "data": {
    "marketerId": 1,
    "balance": 40000,
    "totalWithdrawn": 20000,
    "lastPayoutDate": "2026-07-20T15:30:00Z"
  }
}
```

**Error Codes:**
- `400` - Missing amount or operation
- `400` - Invalid operation (must be "withdraw" or "credit")
- `400` - Insufficient balance
- `404` - Marketer not found
- `400` - User is not a marketer

---

### 3. GET /school-tokens/by-school
**Get token count per school**

**Request:**
```bash
GET /school-tokens/by-school
```

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "school": "St. John School",
      "tokens": 5
    },
    {
      "school": "St. Mary School",
      "tokens": 3
    }
  ]
}
```

---

### 4. PATCH /school-tokens/{id}/revoke
**Revoke a school token**

**Request:**
```bash
PATCH /school-tokens/1/revoke
```

**Response (200):**
```json
{
  "success": true,
  "message": "Token revoked",
  "data": {
    "id": 1,
    "status": "revoked"
  }
}
```

**Error Codes:**
- `400` - Invalid token ID
- `404` - Token not found

---

### 5. GET /commissions
**Get paginated commission list**

**Request:**
```bash
GET /commissions?marketerId=1&page=1&limit=20&startDate=2026-01-01&endDate=2026-07-31
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "commissions": [
      {
        "id": 1,
        "marketerId": 1,
        "amount": 5000,
        "rate": 5,
        "status": "paid",
        "month": 7,
        "year": 2026,
        "source": "Token Sale",
        "createdAt": "2026-07-20T10:30:00Z"
      }
    ],
    "total": 15,
    "page": 1,
    "limit": 20,
    "pages": 1
  }
}
```

**Query Parameters:**
- `marketerId` (required) - Marketer ID
- `page` (optional, default: 1) - Page number
- `limit` (optional, default: 20) - Items per page (max: 100)
- `startDate` (optional) - Filter from date (ISO 8601)
- `endDate` (optional) - Filter until date (ISO 8601)

---

### 6. GET /commissions/summary
**Get commission summary (this month, last month, total, pending)**

**Request:**
```bash
GET /commissions/summary?marketerId=1
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "thisMonth": 50000,
    "lastMonth": 45000,
    "total": 500000,
    "pending": 5000
  }
}
```

---

### 7. PUT /notifications/{id}/read
**Mark single notification as read**

**Request:**
```bash
PUT /notifications/1/read
```

**Response (200):**
```json
{
  "success": true,
  "message": "Notification marked as read"
}
```

---

### 8. PUT /notifications/read-all
**Mark all notifications as read**

**Request:**
```bash
PUT /notifications/read-all?marketerId=1
```

**Response (200):**
```json
{
  "success": true,
  "message": "All notifications marked as read",
  "data": {
    "count": 5
  }
}
```

---

## Phase 2: Profile & Settings

### 9. PUT /users/profile
**Update marketer profile**

**Request:**
```bash
PUT /users/profile?marketerId=1
Content-Type: application/json

{
  "name": "John Marketer Updated",
  "phone": "08012345678",
  "address": "123 Main St",
  "city": "Lagos",
  "state": "Lagos State"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Profile updated",
  "data": {
    "id": 1,
    "name": "John Marketer Updated",
    "email": "marketer@example.com",
    "phone": "08012345678",
    "address": "123 Main St",
    "city": "Lagos",
    "state": "Lagos State"
  }
}
```

---

### 10. PUT /users/password
**Change password**

**Request:**
```bash
PUT /users/password?marketerId=1
Content-Type: application/json

{
  "currentPassword": "oldpassword123",
  "newPassword": "newpassword123"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Password changed successfully"
}
```

**Error Codes:**
- `400` - New password must be at least 8 characters
- `401` - Current password is incorrect
- `404` - Marketer not found

---

### 11. POST /users/avatar
**Upload profile avatar**

**Request:**
```bash
POST /users/avatar?marketerId=1
Content-Type: multipart/form-data

avatar: <binary file>
```

**Response (200):**
```json
{
  "success": true,
  "message": "Avatar uploaded",
  "data": {
    "avatarUrl": "/api/uploads/avatars/user1.jpg"
  }
}
```

---

### 12. GET /settings/banks
**Get list of Nigerian banks**

**Request:**
```bash
GET /settings/banks
```

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "code": "044",
      "name": "Access Bank",
      "slug": "access"
    },
    {
      "code": "033",
      "name": "First Bank",
      "slug": "firstbank"
    }
  ]
}
```

---

### 13. GET /settings/verify-account
**Verify bank account**

**Request:**
```bash
GET /settings/verify-account?accountNumber=1234567890&bankCode=044
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "accountNumber": "1234567890",
    "accountName": "John Marketer",
    "bankCode": "044",
    "verified": true
  }
}
```

---

### 14. PUT /settings/bank-account
**Save bank account details**

**Request:**
```bash
PUT /settings/bank-account?marketerId=1
Content-Type: application/json

{
  "accountNumber": "1234567890",
  "accountName": "John Marketer",
  "bankCode": "044"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Bank account updated",
  "data": {
    "accountNumber": "1234567890",
    "accountName": "John Marketer",
    "bankCode": "044"
  }
}
```

---

### 15. PUT /settings/notifications
**Update notification preferences**

**Request:**
```bash
PUT /settings/notifications?marketerId=1
Content-Type: application/json

{
  "email": true,
  "push": true,
  "commissionAlerts": true,
  "marketingUpdates": false
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Notification preferences updated",
  "data": {
    "email": true,
    "push": true,
    "commissionAlerts": true,
    "marketingUpdates": false
  }
}
```

---

### 16. GET /transactions
**Get transaction history**

**Request:**
```bash
GET /transactions?marketerId=1&page=1&limit=20
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "transactions": [],
    "total": 0,
    "page": 1,
    "limit": 20,
    "pages": 0
  }
}
```

---

### 17. GET /transactions/stats
**Get transaction statistics**

**Request:**
```bash
GET /transactions/stats?marketerId=1
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "totalAmount": 0,
    "transactionCount": 0,
    "averageTransaction": 0
  }
}
```

---

### 18. POST /settings/2fa/toggle
**Enable or disable 2FA**

**Request:**
```bash
POST /settings/2fa/toggle?marketerId=1
Content-Type: application/json

{
  "enabled": true
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "2FA enabled",
  "data": {
    "twoFactorEnabled": true
  }
}
```

---

## Phase 3: Advanced Features

### 19. POST /settings/2fa/setup
**Start 2FA setup (generate QR code)**

**Request:**
```bash
POST /settings/2fa/setup?marketerId=1
```

**Response (200):**
```json
{
  "success": true,
  "message": "2FA setup started",
  "data": {
    "secret": "JBSWY3DPEBLW64TMMQ======",
    "qrCode": "https://chart.googleapis.com/chart?chs=200x200&chld=M|0&cht=qr&chl=secret",
    "manualEntry": "JBSWY3DPEBLW64TMMQ======"
  }
}
```

---

### 20. POST /settings/2fa/verify-setup
**Verify 2FA setup and enable it**

**Request:**
```bash
POST /settings/2fa/verify-setup?marketerId=1
Content-Type: application/json

{
  "secret": "JBSWY3DPEBLW64TMMQ======",
  "code": "123456"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "2FA enabled successfully",
  "data": {
    "twoFactorEnabled": true,
    "backupCodes": [
      "ABCD-1234",
      "EFGH-5678",
      "IJKL-9012"
    ]
  }
}
```

---

### 21. POST /settings/2fa/disable
**Disable 2FA**

**Request:**
```bash
POST /settings/2fa/disable?marketerId=1
Content-Type: application/json

{
  "password": "mypassword123"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "2FA disabled successfully",
  "data": {
    "twoFactorEnabled": false
  }
}
```

---

### 22. GET /commissions/monthly-chart
**Get monthly commission data for charts**

**Request:**
```bash
GET /commissions/monthly-chart?marketerId=1&months=12
```

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "month": "Aug",
      "amount": 50000
    },
    {
      "month": "Jul",
      "amount": 45000
    }
  ]
}
```

---

### 23. GET /marketer-schools/stats
**Get school statistics**

**Request:**
```bash
GET /marketer-schools/stats?marketerId=1
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "totalSchools": 5,
    "activeSchools": 4,
    "suspendedSchools": 1,
    "totalTokensIssued": 150,
    "totalRevenue": 500000
  }
}
```

---

### 24. GET /dashboard/summary
**Get dashboard overview**

**Request:**
```bash
GET /dashboard/summary?marketerId=1
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "walletBalance": 40000,
    "pendingBalance": 5000,
    "totalEarned": 500000,
    "totalWithdrawn": 20000
  }
}
```

---

### 25. GET /dashboard/recent-activity
**Get recent activity feed**

**Request:**
```bash
GET /dashboard/recent-activity?marketerId=1&limit=10
```

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "type": "commission",
      "description": "Commission of ₦5000 paid",
      "timestamp": "2026-07-20T15:30:00Z"
    },
    {
      "type": "notification",
      "description": "Your withdrawal has been processed",
      "timestamp": "2026-07-20T14:00:00Z"
    }
  ]
}
```

---

### 26. PATCH /school-tokens/{id}/status
**Update token status**

**Request:**
```bash
PATCH /school-tokens/1/status
Content-Type: application/json

{
  "status": "used"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Token status updated",
  "data": {
    "id": 1,
    "status": "used"
  }
}
```

**Valid Status Values:**
- `active` - Token is active and can be used
- `used` - Token has been used
- `revoked` - Token has been revoked
- `expired` - Token has expired

---

### 27. DELETE /marketer-schools/{id}
**Delete a marketer's school**

**Request:**
```bash
DELETE /marketer-schools/1
```

**Response (200):**
```json
{
  "success": true,
  "message": "School deleted successfully",
  "data": {
    "id": 1,
    "status": "deleted"
  }
}
```

---

### 28. GET /marketer/{marketerId}/earnings
**Get complete earnings overview**

**Request:**
```bash
GET /marketer/1/earnings
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "marketerId": 1,
    "availableBalance": 40000,
    "pendingBalance": 5000,
    "totalPendingPayout": 45000,
    "totalEarned": 500000,
    "totalWithdrawn": 20000,
    "commissionRate": 5.0,
    "lastPayoutDate": "2026-07-15T00:00:00Z"
  }
}
```

---

## Error Codes

| Code | Status | Meaning |
|------|--------|---------|
| `MISSING_FIELDS` | 400 | Required fields are missing |
| `MISSING_MARKETER_ID` | 400 | marketerId query parameter required |
| `INVALID_ID` | 400 | Invalid ID format |
| `INVALID_REQUEST` | 400 | Invalid request data |
| `INVALID_PASSWORD` | 401 | Password is incorrect |
| `INVALID_TOKEN` | 401 | Token is invalid or expired |
| `INSUFFICIENT_BALANCE` | 400 | Not enough balance for operation |
| `NOT_FOUND` | 404 | Resource not found |
| `INVALID_USER_TYPE` | 400 | User is not a marketer |
| `WEAK_PASSWORD` | 400 | Password doesn't meet requirements |

---

## Examples

### cURL Example: Get Commissions
```bash
curl -X GET \
  'http://localhost:3000/api/public/commissions?marketerId=1&page=1&limit=20' \
  -H 'x-service-key: your-service-key' \
  -H 'Content-Type: application/json'
```

### JavaScript Fetch Example: Update Profile
```javascript
fetch('http://localhost:3000/api/public/users/profile?marketerId=1', {
  method: 'PUT',
  headers: {
    'x-service-key': 'your-service-key',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: 'Updated Name',
    phone: '08012345678',
    city: 'Lagos'
  })
})
.then(res => res.json())
.then(data => console.log(data));
```

### Postman Example
1. Open Postman
2. Set request type to GET
3. Enter URL: `http://localhost:3000/api/public/commissions/summary?marketerId=1`
4. Go to Headers tab
5. Add header:
   - Key: `x-service-key`
   - Value: `your-service-key`
6. Click Send

---

## Documentation Files

- **OpenAPI Spec:** `docs/openapi.yaml` - Machine-readable API specification
- **Swagger UI:** `docs/swagger-ui.html` - Interactive API explorer (open in browser)
- **This Guide:** `docs/ENDPOINT_REFERENCE.md` - Human-readable endpoint reference

---

**Last Updated:** July 20, 2026  
**API Version:** 1.0.0  
**Total Endpoints:** 28
