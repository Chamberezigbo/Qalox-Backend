/**
 * The class ladder: which class a class's students move up to, and the pass
 * mark each class is judged against.
 *
 * Class names are free text and vary between schools ("JSS1", "JSS 2", "SSS3",
 * "SS 1"), so the ladder is SUGGESTED from names and then confirmed by the
 * admin, never applied silently. A name that cannot be read gets no suggestion.
 */

/** Stages in the order students move through them. */
const STAGES = ["PRIMARY", "JSS", "SS"];

/** Final level of each stage, and the stage that follows it. */
const STAGE_RULES = {
  PRIMARY: { last: 6, next: "JSS" },
  JSS: { last: 3, next: "SS" },
  SS: { last: 3, next: null }, // finishing SS means leaving the school
};

/** Pass mark when a class has none set: lower classes 40, senior classes 50. */
const DEFAULT_PASS_MARK = { PRIMARY: 40, JSS: 40, SS: 50 };
const FALLBACK_PASS_MARK = 40;

/**
 * Reads a class name into a stage and level.
 *
 * "JSS 2", "jss2", "J.S.S. 2" -> JSS 2; "SSS1", "SS 3", "S.S.S 1" -> SS 1/3;
 * "Primary 4", "Basic 5", "Pry 6" -> PRIMARY. Anything else -> null.
 *
 * @param {string} name
 * @returns {{ stage: string, level: number } | null}
 */
function parseClassName(name) {
  const text = String(name || "").trim().toUpperCase().replace(/[.\s_-]+/g, "");
  const match = /^(JSS|JS|SSS|SS|PRIMARY|PRY|BASIC|BS)(\d{1,2})$/.exec(text);
  if (!match) return null;

  const [, prefix, digits] = match;
  const level = parseInt(digits, 10);
  const stage = ["JSS", "JS"].includes(prefix) ? "JSS" : ["SSS", "SS"].includes(prefix) ? "SS" : "PRIMARY";

  if (level < 1 || level > STAGE_RULES[stage].last) return null;
  return { stage, level };
}

/** The pass mark to use for a class: its own, else the default for its stage. */
function effectivePassMark(cls) {
  if (typeof cls.passMark === "number") return cls.passMark;
  const parsed = parseClassName(cls.name);
  return parsed ? DEFAULT_PASS_MARK[parsed.stage] : FALLBACK_PASS_MARK;
}

/**
 * Suggests the next class for each class, within one campus.
 *
 * @param {Array<{ id: number, name: string, campusId: number | null }>} classes
 * @returns {Map<number, { nextClassId: number | null, reason: string }>} only for classes whose name was read
 */
function suggestLadder(classes) {
  const suggestions = new Map();

  // Look up by stage + level, per campus: JSS 3 in one campus must never be
  // sent to SS 1 in another.
  const index = new Map();
  for (const cls of classes) {
    const parsed = parseClassName(cls.name);
    if (!parsed) continue;
    const key = `${cls.campusId ?? "none"}|${parsed.stage}|${parsed.level}`;
    // A duplicate name in the same campus is ambiguous: the first one wins, and the admin sees it.
    if (!index.has(key)) index.set(key, cls);
  }

  for (const cls of classes) {
    const parsed = parseClassName(cls.name);
    if (!parsed) continue;

    const rule = STAGE_RULES[parsed.stage];
    const campus = cls.campusId ?? "none";

    let target = null;
    if (parsed.level < rule.last) {
      target = index.get(`${campus}|${parsed.stage}|${parsed.level + 1}`) ?? null;
    } else if (rule.next) {
      target = index.get(`${campus}|${rule.next}|1`) ?? null;
    }

    if (target && target.id !== cls.id) {
      suggestions.set(cls.id, { nextClassId: target.id, reason: `${cls.name} is followed by ${target.name}` });
    } else if (parsed.stage === "SS" && parsed.level === rule.last) {
      suggestions.set(cls.id, { nextClassId: null, reason: `${cls.name} is the final class: students graduate` });
    }
  }

  return suggestions;
}

/**
 * Checks a ladder before it is saved.
 *
 * @param {Array<{ id: number, schoolId: number, campusId: number | null }>} schoolClasses every class of the school
 * @param {Array<{ classId: number, promotesToClassId: number | null }>} entries what the admin wants to save
 * @returns {string | null} the first problem found
 */
function validateLadder(schoolClasses, entries) {
  const byId = new Map(schoolClasses.map((c) => [c.id, c]));
  const next = new Map(schoolClasses.map((c) => [c.id, c.promotesToClassId ?? null]));

  for (const { classId, promotesToClassId } of entries) {
    const from = byId.get(classId);
    if (!from) return `Class ${classId} was not found in this school`;
    if (promotesToClassId == null) {
      next.set(classId, null);
      continue;
    }
    const to = byId.get(promotesToClassId);
    if (!to) return `Class ${promotesToClassId} was not found in this school`;
    if (promotesToClassId === classId) return `${from.name} cannot move up to itself`;
    if ((from.campusId ?? null) !== (to.campusId ?? null)) {
      return `${from.name} and ${to.name} are in different campuses, so one cannot lead to the other`;
    }
    next.set(classId, promotesToClassId);
  }

  // A loop would promote students round in circles for ever.
  for (const start of next.keys()) {
    const seen = new Set([start]);
    let current = next.get(start);
    while (current != null) {
      if (seen.has(current)) return `The classes ${byId.get(start)?.name} lead back to themselves. Check the chain.`;
      seen.add(current);
      current = next.get(current) ?? null;
    }
  }

  return null;
}

module.exports = {
  parseClassName,
  effectivePassMark,
  suggestLadder,
  validateLadder,
  STAGES,
  DEFAULT_PASS_MARK,
  FALLBACK_PASS_MARK,
};
