const { AppError } = require("./AppError");
const { isValidPermission, parsePermissions } = require("./permissions");

/**
 * The campus part of creating or updating a sub-admin.
 *
 * A school with no campus, or one, has nothing to choose: its sub-admins are always
 * "all campuses" and the picker never appears. Only a school with MORE than one campus
 * asks, and then a NEW sub-admin must be given either all campuses or at least one.
 * Every campus named has to be the school's own.
 *
 * @param {object} client prisma or a transaction client
 * Campuses are named either by `campusIds` (every campus uses the sub-admin's own
 * permissions) or by `campuses: [{ campusId, permissions? }]`, where a campus's own
 * `permissions` list overrides the global one for that campus only.
 *
 * @param {{ schoolId: number, body: { allCampuses?: unknown, campusIds?: unknown, campuses?: unknown }, creating: boolean }} input
 * @returns {Promise<{ allCampuses: boolean, campusIds: number[], permissionsByCampus: Record<number, string[] | null> } | undefined>}
 *   undefined means leave the sub-admin's access exactly as it is
 */
async function resolveCampusAccess(client, { schoolId, body, creating }) {
  const campuses = await client.campus.findMany({ where: { schoolId }, select: { id: true } });
  const named = body.allCampuses !== undefined || body.campusIds !== undefined || body.campuses !== undefined;
  const everyCampus = { allCampuses: true, campusIds: [], permissionsByCampus: {} };

  if (campuses.length <= 1) {
    return creating || named ? everyCampus : undefined;
  }

  if (!named) {
    if (creating) {
      throw Object.assign(new AppError("Choose the campuses this sub-admin can work in, or give them all campuses.", 400), {
        code: "CAMPUSES_REQUIRED",
      });
    }
    return undefined;
  }

  if (body.allCampuses === true) return everyCampus;

  // `campuses` (with optional per-campus permissions) wins over plain `campusIds`.
  const entries = Array.isArray(body.campuses)
    ? body.campuses.map((c) => ({ id: Number(c?.campusId), permissions: c?.permissions }))
    : (Array.isArray(body.campusIds) ? body.campusIds : []).map((id) => ({ id: Number(id), permissions: undefined }));
  const ids = [...new Set(entries.map((e) => e.id))];
  const valid = new Set(campuses.map((c) => c.id));

  if (ids.length === 0 || ids.some((id) => !Number.isInteger(id))) {
    throw Object.assign(new AppError("Choose at least one campus, or give this sub-admin all campuses.", 400), {
      code: "CAMPUSES_REQUIRED",
    });
  }
  if (ids.some((id) => !valid.has(id))) {
    throw Object.assign(new AppError("One of those campuses does not belong to this school.", 400), { code: "INVALID_CAMPUSES" });
  }

  // A campus's own permission list: valid keys only; absent/null means "use the global list".
  const permissionsByCampus = {};
  for (const entry of entries) {
    if (entry.permissions === undefined || entry.permissions === null) {
      permissionsByCampus[entry.id] = null;
      continue;
    }
    if (!Array.isArray(entry.permissions) || entry.permissions.some((k) => !isValidPermission(k))) {
      throw Object.assign(new AppError("One of the campus permissions is not valid.", 400), { code: "INVALID_PERMISSIONS" });
    }
    permissionsByCampus[entry.id] = [...new Set(entry.permissions)];
  }
  return { allCampuses: false, campusIds: ids, permissionsByCampus };
}

/** Replaces a sub-admin's campus rows. Run inside the same transaction as the admin update. */
async function saveCampusAccess(tx, adminId, access) {
  await tx.adminCampusAccess.deleteMany({ where: { adminId } });
  if (!access.allCampuses && access.campusIds.length > 0) {
    await tx.adminCampusAccess.createMany({
      data: access.campusIds.map((campusId) => {
        const own = access.permissionsByCampus?.[campusId];
        return { adminId, campusId, permissions: own == null ? null : JSON.stringify(own) };
      }),
    });
  }
}

/** For each admin, the campuses (id and name) they are restricted to; absent for unrestricted ones. */
async function campusesByAdmin(client, admins) {
  const restricted = admins.filter((a) => a.allCampuses === false).map((a) => a.id);
  const map = new Map();
  if (restricted.length === 0) return map;

  const rows = await client.adminCampusAccess.findMany({ where: { adminId: { in: restricted } }, select: { adminId: true, campusId: true, permissions: true } });
  const campuses = await client.campus.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.campusId))] } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(campuses.map((c) => [c.id, c.name]));
  for (const row of rows) {
    const list = map.get(row.adminId) ?? [];
    // permissions: null = this campus uses the sub-admin's own permissions.
    list.push({
      id: row.campusId,
      name: nameOf.get(row.campusId) ?? `Campus ${row.campusId}`,
      permissions: row.permissions == null ? null : parsePermissions(row.permissions),
    });
    map.set(row.adminId, list);
  }
  return map;
}

module.exports = { resolveCampusAccess, saveCampusAccess, campusesByAdmin };
