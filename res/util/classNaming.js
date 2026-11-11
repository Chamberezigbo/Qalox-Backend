/**
 * A school's "naming systems", read from its class names.
 *
 * Schools name classes in their own way ("Primary 1", "Grade 3", "JSS2", "Nursery 1"), so
 * nothing is stored for them: a naming system is just the text in front of the trailing
 * number, and a class belongs to it when its name is "<text> <number>". Renaming a system
 * rewrites that text on every class in it, so the class ids (students, results,
 * timetables) never change.
 */

const NAME_PATTERN = /^(.*?)[\s._-]*(\d{1,3})$/;

/** "Grade 3" -> { prefix: "Grade", level: 3 }; a name with no trailing number -> null. */
function splitClassName(name) {
  const match = NAME_PATTERN.exec(String(name || "").trim());
  if (!match) return null;
  const prefix = match[1].trim();
  if (!prefix) return null;
  return { prefix, level: Number(match[2]) };
}

const buildName = (prefix, level) => `${prefix.trim()} ${level}`;

/** Collapses internal whitespace so "  Grade   " and "Grade" are the same name. */
const cleanPrefix = (value) => String(value || "").replace(/\s+/g, " ").trim();

/**
 * The naming systems found in a list of classes, in the order they first appear.
 * @param {Array<{ id: number, name: string }>} classes
 */
function groupNamingSystems(classes) {
  const groups = new Map();
  for (const cls of classes) {
    const parsed = splitClassName(cls.name);
    if (!parsed) continue;
    const group = groups.get(parsed.prefix) ?? { prefix: parsed.prefix, levels: new Set(), classCount: 0 };
    group.levels.add(parsed.level);
    group.classCount += 1;
    groups.set(parsed.prefix, group);
  }
  return [...groups.values()].map((g) => {
    const levels = [...g.levels].sort((a, b) => a - b);
    return { prefix: g.prefix, classCount: g.classCount, levels, minLevel: levels[0], maxLevel: levels[levels.length - 1] };
  });
}

/**
 * What renaming one naming system would do.
 * @param {Array<{ id: number, name: string, campusId: number | null }>} classes every class of the school (conflicts can come from outside the system)
 * @param {Array<number>} editableIds the classes the admin is allowed to change (campus scope)
 * @returns {{ changes: Array<{ id: number, from: string, to: string }>, conflicts: Array<{ id: number, to: string }> }}
 */
function planRename(classes, editableIds, from, to) {
  const oldPrefix = cleanPrefix(from);
  const newPrefix = cleanPrefix(to);
  const editable = new Set(editableIds);
  const changes = [];
  for (const cls of classes) {
    if (!editable.has(cls.id)) continue;
    const parsed = splitClassName(cls.name);
    if (!parsed || parsed.prefix !== oldPrefix) continue;
    const next = buildName(newPrefix, parsed.level);
    if (next !== cls.name) changes.push({ id: cls.id, from: cls.name, to: next, campusId: cls.campusId ?? null });
  }

  const moving = new Set(changes.map((c) => c.id));
  const taken = new Set(
    classes.filter((c) => !moving.has(c.id)).map((c) => `${c.campusId ?? "none"}|${c.name}`),
  );
  const conflicts = [];
  const claimed = new Set();
  for (const change of changes) {
    const key = `${change.campusId ?? "none"}|${change.to}`;
    if (taken.has(key) || claimed.has(key)) conflicts.push({ id: change.id, to: change.to });
    claimed.add(key);
  }
  return {
    changes: changes.map(({ id, from: f, to: t }) => ({ id, from: f, to: t })),
    conflicts,
  };
}

module.exports = { splitClassName, buildName, cleanPrefix, groupNamingSystems, planRename };
