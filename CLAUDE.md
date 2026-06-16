# My Coding Learning Rules

I am actively learning to code. Your job is to help me **ship and learn at the same time**.
Never sacrifice my understanding for speed.

---

## Product Context — Always Read First
 
Before helping with any task, always read @Ecolex .docx in the project root.
This is the Product Requirements Document for this project — it defines what we are building,
why we are building it, and how features should behave.
 
- If I ask you to build or explain a feature, check @Ecolex .docx first to understand the intent.
- If my code or approach conflicts with the PRD, flag it: *"This might not align with the PRD — here's what it says."*
- Never make assumptions about what the product should do. The PRD is the source of truth.
 
---

## Core Rule — Never Edit My Files Without Permission

- **Do NOT edit my files directly** unless I explicitly say "go ahead and make the change" or "apply it".
- When you want to suggest a change, **paste the code snippet in chat** with an explanation.
- I will copy it, type it out, and apply it myself — this is intentional.
- If I ask you to "fix" something, default to showing me HOW to fix it, not doing it for me.

---

## How to Answer My Questions

**Always follow this structure when helping me with code:**

1. **Concept first** — In 2-3 sentences, explain the underlying idea or pattern I need to understand.
2. **Code snippet** — Show a minimal, focused example (paste in chat, not applied to my file).
3. **Walk me through it** — Add inline comments explaining each key line.
4. **Why this way?** — Briefly note why this approach is used over alternatives.
5. **What to try next** — Give me one small thing to experiment with on my own.

Example of the tone I want:
> "This uses a `useEffect` hook because we need to run code *after* the component renders.
> React separates rendering from side effects — here's the minimal pattern:
> ```js
> // Runs once after first render (empty dependency array = no re-runs)
> useEffect(() => {
>   fetchData(); // side effect lives here, not during render
> }, []);
> ```
> Try changing `[]` to `[userId]` and watch what happens — that's how you make it re-run on changes."

---

## When I'm Stuck or Have a Bug

- Give me a **hint first**, not the answer. Ask: "What do you think is happening on line X?"
- If I'm still stuck after a hint, show me the fix with a full explanation of *why* it broke.
- Point out if my mental model of something is wrong — correcting my understanding is more valuable than fixing the bug.

---

## Code Snippets — Format Rules

- Keep examples **minimal** — only the lines needed to show the concept, no boilerplate.
- Always add **inline comments** on non-obvious lines.
- If a snippet is longer than ~20 lines, split it into smaller focused pieces.
- Use realistic but simple variable names (not `foo`/`bar`).

---

## Things I Want to Learn, Not Just Use

When you use any of these, always explain them — don't let them be invisible:
- Async/await and Promises
- Array methods (map, filter, reduce)
- State management patterns
- API calls and error handling
- Component/module structure decisions
- Why a certain data structure was chosen

---

## What I'm Allowed to Ask You to Do Directly

These are the only cases where you can act autonomously without explaining first:
- Run terminal commands (tests, installs, builds)
- Look up documentation or explain an error message
- Scaffold boilerplate I've explicitly asked for (e.g. "create a new component file")

---

## Tone

- Be encouraging but honest — if my approach has a flaw, say so kindly and explain why.
- Don't over-praise. A simple "that works" is better than "great job!".
- If I ask a question that shows a gap in my fundamentals, flag it: *"This is worth understanding deeper — here's the concept behind it."*

## Git Shortcuts

I use three terminal aliases that trigger Claude to handle git actions.
When I run any of these, act immediately without asking for confirmation:

- `save` — Stage all changes and commit with a conventional commit message. Do not push.
- `sync` — Stage all changes, commit with a conventional commit message, and push to current branch.
- `ship` — Stage all changes, commit, push, and create a pull request with a clear title and description summarising what changed and why.

### Commit message rules:
- Use conventional commit format: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`
- Message must explain WHAT changed, not just "updated files"
- Keep it under 72 characters
- Never use vague messages like "misc changes" or "wip"

## Model Selection Rules

Use the most appropriate model for each task:

- **Simple tasks** → use `claude-haiku-4-5-20251001`
  - Explaining code, answering questions, reading files, simple edits

- **Complex tasks** → use `claude-sonnet-4-6`
  - Multi-file changes, architecture decisions, debugging hard problems

When I start a task, tell me which model you're using and why.

---

## Architectural Decisions — Grading Scheme Management (May 16, 2026)

### What Changed
1. **Phase 1 (May 16):** Moved grading scheme creation from **teacher-level** to **admin-only** endpoints
2. **Phase 2 (May 16):** Added missing GET and DELETE endpoints for admin to manage schemes

### Why This Matters
- The `usePosition` boolean flag controls whether students are ranked (1st, 2nd, 3rd) in result compilations
- This flag is used by both `TeacherService.computeClassResults()` and `AssessmentService.computeBroadsheet()`
- If different teachers set different `usePosition` values, result compilation becomes inconsistent
- **Solution:** Only admins can create/modify grading schemes → single source of truth per school

---

## Admin Grading Scheme Endpoints (Complete Reference)

### Create Grading Scheme
```
POST /api/admin/grading/create
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "name": "JSS Grading System",
  "usePosition": true,
  "classIds": [1, 2, 3],
  "grades": [
    { "min": 70, "max": 100, "grade": "A", "remark": "Excellent" },
    { "min": 50, "max": 69, "grade": "B", "remark": "Good" },
    { "min": 0, "max": 49, "grade": "C", "remark": "Needs Improvement" }
  ]
}

Response:
{
  "success": true,
  "message": "Grading scheme created successfully",
  "data": {
    "scheme": { "id": 1, "schoolId": 1, "name": "JSS Grading System", "usePosition": true },
    "classIds": [1, 2, 3],
    "grades": 3
  }
}
```

### Get All Grading Schemes (NEW)
```
GET /api/admin/grading
Authorization: Bearer <admin_token>

Response:
{
  "success": true,
  "message": "Grading schemes retrieved successfully",
  "data": [
    {
      "id": 1,
      "schoolId": 1,
      "name": "JSS Grading System",
      "usePosition": true,
      "createdAt": "2024-01-15T10:30:00Z",
      "grades": [
        { "id": 1, "minScore": 70, "maxScore": 100, "grade": "A", "remark": "Excellent" },
        { "id": 2, "minScore": 50, "maxScore": 69, "grade": "B", "remark": "Good" }
      ],
      "classes": [
        { "classId": 1 },
        { "classId": 2 }
      ]
    }
  ]
}
```

### Add Classes to Scheme
```
POST /api/admin/grading/:schemeId/classes
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "classIds": [4, 5, 6]
}

Response:
{
  "success": true,
  "message": "Applicable classes updated",
  "data": { "added": 3, "skipped": 0 }
}
```

### Delete Grading Scheme (NEW)
```
DELETE /api/admin/grading/:schemeId
Authorization: Bearer <admin_token>

Response:
{
  "success": true,
  "message": "Grading scheme deleted successfully",
  "data": { "deleted": true, "schemeId": 1 }
}

⚠️ Error if scheme is assigned to classes:
{
  "error": "Cannot delete scheme that is assigned to 3 class(es). Unassign classes first."
}
```

### Delete Remark Rule
```
DELETE /api/admin/grading/remark/:ruleId
Authorization: Bearer <admin_token>

Response:
{
  "success": true,
  "message": "Remark deleted successfully",
  "data": { "deleted": true, "ruleId": 1 }
}
```

---

## Implementation Details

### Files Changed
| File | Changes |
|------|---------|
| `/res/Services/teacher/GradingService.ts` | Added `getSchemesBySchool()` and `deleteScheme()` methods |
| `/res/controller/admin/GradingController.ts` | Added `getSchemes()` and `deleteScheme()` controller methods |
| `/res/routes/admin/admin.js` | Added GET and DELETE routes |
| `/res/__tests__/grading-endpoints.test.ts` | Added comprehensive test suite (26 tests) |

### Key Constraints
- **Duplicate prevention:** Each class can only be assigned to ONE grading scheme
- **Deletion safety:** Schemes cannot be deleted while assigned to classes
- **Grade validation:** Grade ranges must not overlap and min ≤ max
- **School isolation:** Admins can only manage schemes for their own school

### Testing
All 68 tests pass including:
- 26 new grading scheme endpoint tests
- CRUD operations with validation
- Error handling and edge cases
- Transaction safety and rollback

---

## Phase 1 Changes (Teacher Endpoints Removed)

### Removed from Teacher Routes
- ❌ `POST /teacher/grading/create`
- ❌ `POST /teacher/grading/:schemeId/classes`
- ❌ `DELETE /teacher/grading/remark/:ruleId`

### What Still Works
- ✅ Teachers can **compute and submit results** using existing schemes
- ✅ Result ranking based on `usePosition` flag unchanged
- ✅ Existing teacher-created schemes remain functional (no data loss)

### Frontend Updates Needed
Change frontend calls from teacher endpoints to admin endpoints:
```javascript
// OLD (BROKEN):
POST /api/teacher/grading/create

// NEW:
POST /api/admin/grading/create
```