# 📚 Qalox Marketer Portal API Documentation

Welcome to the complete API documentation for the Qalox Marketer Portal backend. All resources are organized in this directory.

## 📖 Documentation Files

### 1. **OpenAPI Specification** (`openapi.yaml`)
   - **Format:** YAML (OpenAPI 3.0)
   - **Use Case:** Machine-readable API specification
   - **Features:**
     - Complete endpoint definitions
     - Request/response schemas
     - Error codes
     - Authentication details
     - Parameter documentation
   - **Tools:** Can be imported into Postman, Swagger Editor, API clients
   - **Size:** ~40KB

### 2. **Swagger UI** (`swagger-ui.html`)
   - **Format:** Interactive HTML page
   - **Use Case:** Visual API explorer in browser
   - **Features:**
     - Click-to-try endpoint testing
     - Request/response visualization
     - Schema exploration
     - Live documentation
   - **How to Use:** Open in any web browser
   - **Note:** Requires internet connection for Swagger UI CDN

### 3. **Endpoint Reference Guide** (`ENDPOINT_REFERENCE.md`)
   - **Format:** Markdown
   - **Use Case:** Developer-friendly endpoint reference
   - **Features:**
     - All 28 endpoints documented
     - Real request/response examples
     - Query parameters explained
     - Error codes with descriptions
     - cURL and JavaScript examples
     - Organized by Phase
   - **Best For:** Quick reference while coding

---

## 🚀 Quick Start

### View Interactive Documentation
1. Open `swagger-ui.html` in your web browser
2. Explore endpoints by category
3. Click "Try it out" to test endpoints
4. Add `x-service-key` header for authentication

### Find an Endpoint
Use the Endpoint Reference guide to find what you need:
- Phase 1: Authentication, Wallet, Commissions (8 endpoints)
- Phase 2: Profile & Settings (10 endpoints)
- Phase 3: Advanced Features (10 endpoints)

### Test with Postman
1. Import `openapi.yaml` into Postman
2. Add `x-service-key` header
3. Start making requests

---

## 📊 API Overview

| Metric | Value |
|--------|-------|
| **Total Endpoints** | 28 |
| **Base URL** | `/api/public` |
| **Authentication** | `x-service-key` header |
| **Response Format** | JSON |
| **OpenAPI Version** | 3.0.0 |
| **Production Ready** | ✅ Yes |

---

## 🔐 Authentication

All endpoints require the `x-service-key` header:

```bash
curl -H "x-service-key: your-service-key" \
  http://localhost:3000/api/public/commissions/summary?marketerId=1
```

---

## 📋 Endpoint Summary

### Phase 1: Core Features (8 endpoints)
- ✅ POST `/auth/2fa/verify` - Verify 2FA code
- ✅ POST `/marketers/{id}/wallet` - Withdraw/credit funds
- ✅ GET `/school-tokens/by-school` - Token counts
- ✅ PATCH `/school-tokens/{id}/revoke` - Revoke token
- ✅ GET `/commissions` - Commission list
- ✅ GET `/commissions/summary` - Commission summary
- ✅ PUT `/notifications/{id}/read` - Mark notification read
- ✅ PUT `/notifications/read-all` - Mark all read

### Phase 2: Profile & Settings (10 endpoints)
- ✅ PUT `/users/profile` - Update profile
- ✅ PUT `/users/password` - Change password
- ✅ POST `/users/avatar` - Upload avatar
- ✅ GET `/settings/banks` - List Nigerian banks
- ✅ GET `/settings/verify-account` - Verify bank account
- ✅ PUT `/settings/bank-account` - Save bank details
- ✅ PUT `/settings/notifications` - Update notification prefs
- ✅ GET `/transactions` - Transaction history
- ✅ GET `/transactions/stats` - Transaction stats
- ✅ POST `/settings/2fa/toggle` - Enable/disable 2FA

### Phase 3: Advanced Features (10 endpoints)
- ✅ POST `/settings/2fa/setup` - Start 2FA setup
- ✅ POST `/settings/2fa/verify-setup` - Verify & enable 2FA
- ✅ POST `/settings/2fa/disable` - Disable 2FA
- ✅ GET `/commissions/monthly-chart` - Monthly commission data
- ✅ GET `/marketer-schools/stats` - School statistics
- ✅ GET `/dashboard/summary` - Dashboard overview
- ✅ GET `/dashboard/recent-activity` - Recent activity
- ✅ PATCH `/school-tokens/{id}/status` - Update token status
- ✅ DELETE `/marketer-schools/{id}` - Delete school
- ✅ GET `/marketer/{id}/earnings` - Earnings overview

---

## 🛠️ Common Tasks

### I want to...

**...test an endpoint**
→ Open `swagger-ui.html` and click "Try it out"

**...understand request/response format**
→ See `ENDPOINT_REFERENCE.md` for examples

**...import into Postman**
→ Use `openapi.yaml` (File → Import)

**...understand error codes**
→ See "Error Codes" section in `ENDPOINT_REFERENCE.md`

**...see all endpoints at once**
→ View `openapi.yaml` in any text editor

**...integrate into my API client**
→ Use `openapi.yaml` for code generation

---

## 📝 Response Format

All responses follow this format:

**Success (200-201):**
```json
{
  "success": true,
  "message": "Operation successful",
  "data": { /* endpoint-specific data */ }
}
```

**Error (400-500):**
```json
{
  "success": false,
  "message": "Error description",
  "code": "ERROR_CODE"
}
```

---

## 🔍 Key Features

### Comprehensive Documentation
- Every endpoint documented
- Request and response examples
- Query parameters explained
- Error scenarios covered

### Developer-Friendly
- Multiple formats (OpenAPI YAML, Interactive UI, Markdown)
- Real-world code examples (cURL, JavaScript)
- Organized by functionality

### Production-Ready
- Full authentication details
- Error code reference
- Rate limiting guidelines (if applicable)
- Best practices

### Easy Integration
- OpenAPI spec for code generation
- Postman collection ready
- Clear examples for each endpoint

---

## 🚨 Important Notes

1. **Authentication Required:** All endpoints need `x-service-key` header
2. **Query Parameters:** Use query strings for filtering and pagination
3. **Request Body:** POST/PUT/PATCH endpoints use JSON bodies
4. **File Uploads:** Avatar endpoint uses `multipart/form-data`
5. **Timestamps:** All dates use ISO 8601 format
6. **Error Handling:** Always check `success` field in response

---

## 📞 Support

For issues with the API:
1. Check the error code in `ENDPOINT_REFERENCE.md`
2. Review the OpenAPI spec for parameter requirements
3. Test with Swagger UI to isolate issues
4. Check server logs for detailed error messages

---

## 📦 Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-07-20 | Initial release: 28 endpoints |

---

## 📄 Files Checklist

- ✅ `openapi.yaml` - OpenAPI specification
- ✅ `swagger-ui.html` - Interactive API explorer
- ✅ `ENDPOINT_REFERENCE.md` - Detailed endpoint guide
- ✅ `README.md` - This file (documentation index)

---

**Last Updated:** July 20, 2026  
**API Version:** 1.0.0  
**Status:** Production Ready ✅

---

## Quick Links

- [OpenAPI Specification](openapi.yaml)
- [Swagger UI](swagger-ui.html) *(Open in browser)*
- [Endpoint Reference](ENDPOINT_REFERENCE.md)
- [View in OpenAPI Editor](https://editor.swagger.io/)

---

*Generated: July 20, 2026*  
*Qalox Marketer Portal API v1.0.0*
