/**
 * The name, logo and stamp a document or screen shows for a campus.
 *
 * Each campus can have its own logo, stamp and name. Anything it does not have falls
 * back to the school's, so a school that never set one up looks exactly as before. The
 * campus NAME replaces the school name only when the school really has several
 * campuses: a school with a single campus ("Main") keeps its own name.
 */

/** A student's campus: their own, else their class's. */
const effectiveCampusId = (student) => student?.campusId ?? student?.class?.campusId ?? null;

/**
 * @param {object} client prisma or a transaction client
 * @param {{ schoolId: number, campusId?: number | null }} input
 * @returns {Promise<{ name: string | null, logoUrl: string | null, stampUrl: string | null, brandColor: string | null, campusName: string | null }>}
 *   logoUrl / stampUrl are stored keys; pass them through schoolMediaUrl to get a link.
 */
async function resolveBranding(client, { schoolId, campusId }) {
  const school = await client.school.findUnique({
    where: { id: schoolId },
    select: { name: true, logoUrl: true, stampUrl: true, brandColor: true },
  });
  const base = {
    name: school?.name ?? null,
    logoUrl: school?.logoUrl ?? null,
    stampUrl: school?.stampUrl ?? null,
    brandColor: school?.brandColor ?? null,
    campusName: null,
  };
  if (!campusId) return base;

  const [campus, campusCount] = await Promise.all([
    client.campus.findFirst({
      where: { id: campusId, schoolId },
      select: { name: true, logoUrl: true, stampUrl: true, brandColor: true },
    }),
    client.campus.count({ where: { schoolId } }),
  ]);
  if (!campus) return base;

  return {
    name: campusCount > 1 ? campus.name : base.name,
    logoUrl: campus.logoUrl ?? base.logoUrl,
    stampUrl: campus.stampUrl ?? base.stampUrl,
    brandColor: campus.brandColor ?? base.brandColor,
    campusName: campus.name,
  };
}

module.exports = { resolveBranding, effectiveCampusId };
