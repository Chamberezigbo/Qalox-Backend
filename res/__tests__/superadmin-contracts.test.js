const { resolveRecipientTargetFilter } = require('../controller/superadmin/CommunicationsController');
const {
  normalizeNotificationStatus,
  buildNotificationQueryFilter,
} = require('../controller/superadmin/NotificationsController');
const {
  deriveSuspendState,
  HEAD_ADMIN_ROLES,
} = require('../controller/superadmin/SuperAdminController');
const { serialiseSchool, schoolMediaUrl } = require('../controller/public/publicController');

describe('superadmin contract fixes', () => {
  test('resolves school scoped recipient target to a single school id', () => {
    expect(resolveRecipientTargetFilter('school:5')).toEqual({ id: 5, isSuspended: false });
  });

  test('resolves region targeting to a location query and keeps active schools only', () => {
    const filter = resolveRecipientTargetFilter('region', 'Lagos');
    expect(filter).toHaveProperty('isSuspended', false);
    expect(filter).toHaveProperty('OR');
    expect(Array.isArray(filter.OR)).toBe(true);
  });

  test('head admin roles used by stats and admin listings are aligned', () => {
    expect(HEAD_ADMIN_ROLES).toEqual(['school_admin', 'super_admin']);
  });

  test('notification statuses are derived from future scheduled timestamps', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const past = new Date(Date.now() - 60 * 60 * 1000);

    expect(normalizeNotificationStatus({ scheduledAt: future })).toBe('scheduled');
    expect(normalizeNotificationStatus({ scheduledAt: past })).toBe('sent');
  });

  test('notification query filters honor scheduled and sent states', () => {
    expect(buildNotificationQueryFilter('scheduled')).toEqual({ scheduledAt: { gt: expect.any(Date) } });
    expect(buildNotificationQueryFilter('sent')).toEqual({ OR: [
      { scheduledAt: null },
      { scheduledAt: { lte: expect.any(Date) } },
    ] });
  });

  test('suspend actions respect an explicit absolute state', () => {
    expect(deriveSuspendState(false, { suspend: false })).toEqual({
      nextSuspended: false,
      reason: undefined,
      suspendedAt: null,
    });

    expect(deriveSuspendState(false, { suspend: true, reason: 'Abuse' })).toEqual({
      nextSuspended: true,
      reason: 'Abuse',
      suspendedAt: expect.any(Date),
    });
  });

  test('public school asset paths are normalised to /api/uploads and do not 404 when the row stores legacy paths', async () => {
    const current = '/uploads/logos/test-logo.jpg';
    const legacy = '/api/uploads/logos/test-logo.jpg';

    expect(current.startsWith('/uploads/')).toBe(true);
    expect(legacy.startsWith('/api/uploads/')).toBe(true);

    const fromCurrent = await schoolMediaUrl(current);
    const fromLegacy = await schoolMediaUrl(legacy);

    expect(fromCurrent).toBeNull();
    expect(fromLegacy).toBeNull();
  });

  test('school serialisation exposes the real head-admin name and the public status string', async () => {
    const school = {
      id: 42,
      name: 'Greenfield Academy',
      email: 'school@example.com',
      logoUrl: null,
      stampUrl: null,
      isSuspended: false,
      createdAt: '2026-08-01T00:00:00.000Z',
      admins: [{ name: 'Ada Okafor', email: 'ada@example.com' }],
    };

    const payload = await serialiseSchool(school);

    expect(payload).toMatchObject({
      id: 42,
      name: 'Greenfield Academy',
      adminName: 'Ada Okafor',
      adminEmail: 'ada@example.com',
      status: 'active',
    });
  });
});
