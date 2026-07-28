# 📚 Qalox API Documentation Setup Guide

## Quick Start

### Enable Documentation (3 Ways)

#### Option 1: Auto-Start with Docs (Recommended)

**macOS/Linux:**
```bash
chmod +x scripts/start-with-docs.sh
./scripts/start-with-docs.sh
```
✅ Automatically opens Swagger UI in browser after server starts

**Windows:**
```cmd
scripts/start-with-docs.bat
```
✅ Automatically opens Swagger UI in browser after server starts

---

#### Option 2: Manual Start with Env Variable

```bash
# Set environment variable
ENABLE_DOCS=true npm run dev

# Or on Windows:
set ENABLE_DOCS=true && npm run dev
```

Then open browser to: **http://localhost:3000/docs**

---

#### Option 3: Update .env File

Edit `.env` file:
```env
ENABLE_DOCS="true"
```

Then start normally:
```bash
npm run dev
```

Then open browser to: **http://localhost:3000/docs**

---

## 🎯 Accessing Documentation

Once docs are enabled and server is running, you have **three separate API documentations**:

| Resource | URL | Description |
|----------|-----|-------------|
| **Marketer Portal API** | `http://localhost:3000/docs` | Marketer Portal endpoints (28 endpoints) |
| **School System API** | `http://localhost:3000/docs/school-system` | School management endpoints (100+ endpoints) |
| **Documentation Index** | `http://localhost:3000/api/docs` | JSON index of all documentation |
| **OpenAPI Specs** | `/api/docs/openapi.yaml` | Marketer Portal YAML spec |
| | `/api/docs/openapi-school-system.yaml` | School System YAML spec |
| **Reference Guide** | `http://localhost:3000/api/docs/reference` | Developer reference (Markdown) |

---

## ✨ Features

### Swagger UI at `/docs`
- 🎨 Beautiful interactive interface
- 📝 Try out endpoints directly in browser
- 🔍 Full request/response inspection
- 📊 Schema visualization
- 🔐 Authentication header support (x-service-key)

### Endpoints Documented
- ✅ All 28 endpoints
- ✅ Request/response examples
- ✅ Query parameters
- ✅ Error codes
- ✅ Authentication details

### Environment-Based
- 🔧 Enable with `ENABLE_DOCS=true`
- 🚫 Disable by default (security)
- 💾 No performance impact when disabled

---

## 🛠️ Architecture

### How It Works

```
Request to /docs
    ↓
Documentation Middleware
    ├─ Checks ENABLE_DOCS env variable
    ├─ Serves Swagger UI HTML
    └─ Provides /api/docs/openapi.yaml
        ↓
    Swagger UI loads OpenAPI spec
        ↓
    Interactive API explorer ready
```

### File Structure

```
Qalox/
├── scripts/
│   ├── start-with-docs.sh    (macOS/Linux starter)
│   └── start-with-docs.bat   (Windows starter)
├── docs/
│   ├── openapi.yaml          (OpenAPI specification)
│   ├── ENDPOINT_REFERENCE.md (Developer reference)
│   ├── README.md             (Documentation index)
│   └── SETUP.md              (This file)
├── res/middleware/
│   └── documentation.js       (Docs middleware)
├── .env                       (ENABLE_DOCS=true)
└── app.ts                     (Middleware integration)
```

---

## 📋 Configuration Options

### Enable Documentation
```env
ENABLE_DOCS="true"
```
- Enables Swagger UI at `/docs`
- Serves OpenAPI spec at `/api/docs/openapi.yaml`
- Logs when documentation is accessed

### Disable Documentation
```env
ENABLE_DOCS="false"
# OR omit the variable entirely
```
- No documentation endpoints registered
- No performance overhead
- Good for production if not needed

---

## 🚀 Usage Examples

### Try an Endpoint in Swagger UI

1. **Open:** http://localhost:3000/docs
2. **Find:** The endpoint you want to test (e.g., GET /commissions)
3. **Click:** "Try it out"
4. **Add Header:** Set `x-service-key` in headers
5. **Add Params:** Fill in query parameters (e.g., `marketerId=1`)
6. **Execute:** Click "Execute" button
7. **View:** Response appears below

### Import into Postman

1. Open Postman
2. Click "Import"
3. Enter URL: `http://localhost:3000/api/docs/openapi.yaml`
4. Collection auto-creates with all endpoints
5. Add `x-service-key` header to environment
6. Start testing

### Generate API Client

Use OpenAPI spec to generate client code:

```bash
# Generate TypeScript client
npx openapi-generator-cli generate \
  -i http://localhost:3000/api/docs/openapi.yaml \
  -g typescript-axios \
  -o ./generated-client
```

---

## 🔒 Security Notes

### Production Deployments

By default, `ENABLE_DOCS` is set to `true` in `.env` for development.

**For Production:**
```env
ENABLE_DOCS="false"
```

Or remove from .env entirely. This prevents exposing API details in production.

### Authentication Header

Swagger UI includes a default placeholder `x-service-key` header. Replace with actual service key when testing.

---

## 📝 Logging

When docs are enabled, all documentation access is logged:

```
[INFO] ✅ Documentation endpoint enabled at /docs
[INFO] [DOCS] Swagger UI accessed
[DEBUG] [DOCS] OpenAPI spec requested
[DEBUG] [DOCS] Endpoint reference requested
```

Check logs to verify docs are working:
```bash
tail -f error.log | grep "\[DOCS\]"
```

---

## 🐛 Troubleshooting

### Docs not showing at /docs

**Problem:** Page shows 404 error
**Solution:** 
1. Check `ENABLE_DOCS=true` in .env
2. Restart server: `npm run dev`
3. Check server logs for "Documentation endpoint enabled"

### Swagger UI won't load

**Problem:** Blank page or "Failed to load spec"
**Solution:**
1. Check browser console for errors (F12)
2. Verify `/api/docs/openapi.yaml` returns YAML content
3. Check that openapi.yaml file exists in `docs/` directory

### Headers not working in Swagger

**Problem:** Can't see x-service-key in Swagger UI
**Solution:**
1. Refresh browser page
2. Check browser network tab (F12 → Network)
3. Verify request includes `x-service-key` header

### Performance slow

**Problem:** Server is slow with docs enabled
**Solution:**
- Documentation only loads on `/docs` request
- No overhead during normal API requests
- If still slow, check: network/internet speed, CDN availability for Swagger UI

---

## 📞 Support

**Getting Help:**
1. Check this file first (SETUP.md)
2. Review `docs/ENDPOINT_REFERENCE.md` for endpoint details
3. Check `docs/README.md` for documentation overview
4. Review server logs for errors

**Common Issues:**
- OpenAPI spec missing: Ensure `docs/openapi.yaml` exists
- Documentation middleware not loading: Check app.ts integration
- Wrong port: Verify `PORT` in .env (default: 3000)

---

## 📚 Related Files

- [Endpoint Reference](ENDPOINT_REFERENCE.md) - Complete endpoint documentation
- [OpenAPI Spec](openapi.yaml) - Machine-readable API specification
- [Documentation Index](README.md) - Overview of all documentation

---

## ✅ Checklist

- [ ] ENABLE_DOCS="true" set in .env
- [ ] Server started with `npm run dev`
- [ ] Can access http://localhost:3000/docs
- [ ] Swagger UI loads successfully
- [ ] Can see all 28 endpoints listed
- [ ] Can "Try it out" on an endpoint
- [ ] x-service-key header visible in requests

---

**Documentation System:** ✅ Active  
**Last Updated:** July 20, 2026  
**OpenAPI Version:** 3.0.0
