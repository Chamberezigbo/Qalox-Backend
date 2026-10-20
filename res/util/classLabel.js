/**
 * A class's display name. A custom name with no letters or digits (".", "-", "…" typed
 * as a placeholder) is not a name, so it is left out: "SS 2", not "SS 2 — .".
 */
const usableCustomName = (customName) => {
  const text = typeof customName === "string" ? customName.trim() : "";
  return /[\p{L}\p{N}]/u.test(text) ? text : null;
};

const classDisplayName = (name, customName) => {
  const custom = usableCustomName(customName);
  return custom ? `${name} — ${custom}` : name;
};

module.exports = { usableCustomName, classDisplayName };
