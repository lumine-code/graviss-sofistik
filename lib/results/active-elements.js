const { GROUP_FLAGS } = require("@lumine-code/sofistik-reader");

// GRP_LC records state whether a group participated in this particular case.
// A zero displacement or an absent element-force record says nothing about
// participation; only the group's active bit does.
async function readActiveGroups(database, loadCaseId) {
  let read;
  try {
    read = await database.read("loadCaseGroups", loadCaseId, { decodePolicy: "variable-tail" });
  } catch (error) {
    if (error.code === "ERR_CDB_RECORD_UNAVAILABLE") return null;
    throw error;
  }
  if (!read.count) return null;
  const groups = new Map();
  const { ng, typ, inf } = read.columns;
  for (let index = 0; index < read.count; index += 1) {
    // The per-family records repeat the same status. Prefer the whole-group
    // record when present, while accepting a release that stores only families.
    if (typ[index] !== 0 && groups.has(ng[index])) continue;
    groups.set(ng[index], (inf[index] & GROUP_FLAGS.active) !== 0);
  }
  return groups;
}

function activeElementIds(geometry, groups) {
  return geometry.elements
    .filter((element) => groups.get(element.filterValues?.group) !== false)
    .map((element) => element.id);
}

module.exports = { readActiveGroups, activeElementIds };
