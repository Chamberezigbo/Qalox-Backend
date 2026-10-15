/**
 * The rules for moving a published test's closing time and for reopening a test.
 *
 * Kept free of the database so each rule is pinned by a test. Everything else
 * about a published test stays locked: students may already have answered the
 * questions, and moving a closing time is the one change that is safe to make.
 */

/** A published test whose closing time has passed is closed in practice, though its status still says published. */
function hasEnded(test, now) {
  return test.status === "closed" || (test.status === "published" && test.closesAt != null && new Date(test.closesAt) <= now);
}

/**
 * Validates a requested closing time.
 *
 * @param {object} input
 * @param {Date} input.now
 * @param {Date | string | null} input.opensAt
 * @param {Date | string | null | undefined} input.requested the new closing time
 * @returns {{ ok: true, closesAt: Date } | { ok: false, message: string }}
 */
function validateNewClosingTime({ now, opensAt, requested }) {
  if (requested === undefined || requested === null || requested === "") {
    return { ok: false, message: "Choose when the test should close." };
  }
  const closesAt = new Date(requested);
  if (Number.isNaN(closesAt.getTime())) return { ok: false, message: "That closing time is not a valid date." };
  if (closesAt <= now) return { ok: false, message: "The closing time must be in the future." };
  if (opensAt && closesAt <= new Date(opensAt)) {
    return { ok: false, message: "The closing time must be after the opening time." };
  }
  return { ok: true, closesAt };
}

/**
 * What reopening a closed test needs: a new closing time only when the old one
 * would shut it again straight away.
 *
 * @returns {{ ok: true, closesAt: Date | null | undefined } | { ok: false, message: string, conflict?: boolean }}
 *   closesAt undefined means leave the stored value alone
 */
function planReopen({ test, now, requested }) {
  if (test.status === "draft") {
    return { ok: false, conflict: true, message: "This test has not been published yet." };
  }
  if (test.status !== "closed" && !hasEnded(test, now)) {
    return { ok: false, conflict: true, message: "This test is still open." };
  }

  const oldStillFuture = test.closesAt == null || new Date(test.closesAt) > now;
  const gaveOne = requested !== undefined && requested !== null && requested !== "";

  if (!gaveOne) {
    if (oldStillFuture) return { ok: true, closesAt: undefined };
    return { ok: false, message: "Its closing time has passed. Choose a new closing time to reopen it." };
  }

  const checked = validateNewClosingTime({ now, opensAt: test.opensAt, requested });
  return checked.ok ? { ok: true, closesAt: checked.closesAt } : checked;
}

module.exports = { hasEnded, validateNewClosingTime, planReopen };
