# Architecture & Product Decisions

## Multi-School Architecture

Decision:

- Single database, multi-tenant using `schoolId`

Reason:

- Lower operational cost
- Easier scaling

---

## Who Enters Results?

Decision:

- Teachers enter student results

Reason:

- Teachers own academic records
- Admins should not manipulate grades

---

## Result Editing Rules

Decision:

- Teachers can edit until submission
- After submission, results are locked
- Admin can unlock if needed

Reason:

- Prevent grade tampering
- Maintain integrity
