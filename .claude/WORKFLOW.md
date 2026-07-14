# Qalox Development Workflow

This document describes the recommended workflow for developing Qalox efficiently and catching issues early.

---

## 🔄 Three-Phase Workflow

### Phase 1: Exploration & Planning (Before You Code)

**Goal:** Understand the codebase and plan your approach.

**Commands:**
```bash
/explore
```
- Fast read-only search agent that locates code patterns
- Find where specific functions/features are implemented
- Understand existing patterns before building new ones

```bash
/plan
```
- Software architect agent that designs implementation strategy
- Maps out critical files
- Considers architectural trade-offs
- Identifies edge cases and dependencies

**When to use:**
- Starting a new feature
- Fixing a complex bug
- Refactoring existing code
- Before touching core services (TeacherService, AssessmentService)

---

### Phase 2: Code Review (Before You Commit)

**Goal:** Catch bugs, simplification opportunities, and performance issues.

**Command:**
```bash
/code-review
```
- Reviews your changes for correctness bugs
- Suggests simplifications and efficiency improvements
- Flags potential issues
- Available at different effort levels: `low`, `medium`, `high`, `xhigh`, `ultra`

**Examples:**
```bash
/code-review low              # Quick pass (confidence issues only)
/code-review medium           # Standard review
/code-review ultra --comment  # Deep cloud review, posts inline comments
```

**Automatic reminder:** After you edit a file, Claude will suggest running `/code-review`

**When to use:**
- Before committing any changes
- After writing new business logic
- Before pushing to remote
- For critical services (grading, assessment computation)

---

### Phase 3: Git Shortcuts (Commit & Push)

**Goal:** Commit and push changes with conventional commit messages.

**Available shortcuts:**

```bash
save
```
- Stages all changes
- Creates a commit with conventional commit message
- Does NOT push

**Use when:** You've made changes locally and want to save progress.

```bash
sync
```
- Stages all changes
- Creates a commit with conventional commit message
- Pushes to current branch

**Use when:** You're working on a branch and want to push changes.

```bash
ship
```
- Stages all changes
- Creates a commit with conventional commit message
- Pushes to current branch
- Creates a pull request with clear title and description

**Use when:** You're ready to merge to main (after /code-review approval).

---

## 📋 Commit Message Convention

All commits follow **Conventional Commits** format:

```
<type>: <description>
```

**Types:**
- `feat:` - New feature
- `fix:` - Bug fix
- `refactor:` - Code refactoring (no feature change)
- `test:` - Tests added or updated
- `docs:` - Documentation
- `chore:` - Dependency updates, build changes

**Rules:**
- Keep description under 72 characters
- Explain WHAT changed, not just "updated files"
- Never use vague messages like "misc changes" or "wip"

**Examples:**
```
feat: add student metrics dashboard endpoint
fix: prevent duplicate CA entries when assigning subjects
refactor: simplify GradingService grade computation logic
test: add 10 new tests for PublishedResult publication
docs: update assessment system architecture guide
```

---

## 🎯 Workflow by Task Type

### Adding a New Feature
```
1. /explore           → Understand existing patterns
2. /plan              → Map out implementation
3. Write code
4. npm test           → Run tests
5. /code-review       → Check for issues
6. save / sync / ship → Commit and push
```

### Fixing a Bug
```
1. /explore           → Locate the bug's source
2. Understand the root cause
3. Write fix
4. npm test           → Verify fix + no regressions
5. /code-review       → Ensure fix is solid
6. ship               → Create PR with explanation
```

### Refactoring
```
1. /explore           → Find all related code
2. /plan              → Design refactor strategy
3. Refactor code
4. npm test           → Ensure behavior unchanged
5. /code-review       → Check for clarity improvements
6. save               → Commit (don't push yet until approved)
```

### Investigating Architecture
```
/explore              → Search for patterns
/plan                 → Understand design decisions
Read docs/            → Check documentation
Check DECISIONS.md    → Review architectural choices
```

---

## ⚠️ Important Rules

### Before You Push
- ✅ Run `/code-review`
- ✅ Run `npm test` locally
- ✅ Verify no secrets in code
- ✅ Check commits follow conventional format

### Never Skip
- ❌ Don't skip `/code-review` for critical services
- ❌ Don't push broken tests
- ❌ Don't commit credentials or .env files
- ❌ Don't force push to main

### When Making Changes to Core Services
**Alert:** These are complex and need extra care:
- `res/Services/teacher/TeacherService.ts` - Result computation
- `res/Services/AssessmentService.ts` - CA/Exam management
- `res/Services/teacher/GradingService.ts` - Grade application
- `res/controller/admin/GradingController.ts` - Grading scheme validation

For these:
1. Always use `/plan` first
2. Always use `/code-review` before committing
3. Run full test suite: `npm test`
4. Consider edge cases (multi-campus, different grading schemes)

---

## 🚀 Quick Reference

| Want To... | Command |
|-----------|---------|
| Start a new task | `/explore` → `/plan` |
| Understand existing code | `/explore quick` |
| Find where X is defined | `/explore` with keyword |
| Map architecture | `/plan` |
| Catch bugs in my changes | `/code-review medium` |
| Deep review before ship | `/code-review ultra` |
| Commit + push | `sync` |
| Commit + push + PR | `ship` |
| Just save locally | `save` |

---

## 💡 Tips

- **Use `/explore` before `/plan`** — Understanding existing code informs better architecture
- **Commit frequently** — Smaller commits are easier to review and revert if needed
- **Read error messages carefully** — They often point to the real issue
- **Test locally before pushing** — `npm test` catches most issues
- **Check CLAUDE.md** — Contains learning guidelines and patterns for this repo

---

## 🔐 Security Checklist

Before every `ship`:
- [ ] No hardcoded secrets in code
- [ ] No `.env` files committed
- [ ] No credentials in error messages
- [ ] No SQL injection vulnerabilities (use Prisma)
- [ ] Input validation on all endpoints (use Joi schemas)
- [ ] Authorization checks on protected routes
- [ ] Passwords hashed (bcryptjs)
- [ ] JWT tokens not exposed in logs

---

**Questions?** Check the CLAUDE.md in project root for learning guidelines.
