// The classifications SOFiSTiK writes in the load case's leading int, against
// the words the contract uses. Only two of them change what a viewer does - an
// eigenmode and a buckling mode have no sign, so their shape is animated about
// zero - and the rest are named because a user reads them.
//
// Influence lines and train loads have no word in the contract. A provider that
// cannot classify a case leaves `kind` out and the case is treated as ordinary,
// which is what those two are: they have a sign.
const LOAD_CASE_KINDS = new Map([
  [0, "linear"],
  [1, "nonlinear"],
  [2, "superposition"],
  [4, "eigenmode"],
  [5, "buckling"],
  [6, "design"],
  [8, "transient"],
]);

function loadCaseKind(kind) {
  return LOAD_CASE_KINDS.get(kind);
}

// Every load case that carries nodal displacements or beam forces. A load
// definition is not a result: SOFiSTiK keeps cases that were loaded but never
// solved in LC_CTRL as well, and offering one only produces an empty field.
// Eigenmodes use the CDB_LC_EIGE variant under the same key, which the reader
// returns as `eigenmode` rather than in the ordinary record's columns.
async function readLoadCases(database) {
  const numbers = Array.from(await database.keys("loadCase"));
  if (!numbers.length) return [];
  // Asked once rather than probing every definition separately.
  const resultKeys = await Promise.all([database.keys("nodeResults"), database.keys("beamForces")]);
  const solved = new Set(resultKeys.flatMap((keys) => Array.from(keys)));
  const loadCases = [];
  for (const number of numbers) {
    if (!solved.has(number)) continue;
    const read = await database.read("loadCase", number, { decodePolicy: "variable-tail" });
    const record = read.eigenmode?.count
      ? read.eigenmode
      : read.superposition?.count
        ? read.superposition
        : read;
    if (!record.count) continue;
    const title = record.columns.rtex?.[0];
    const kind = loadCaseKind(record.columns.kind?.[0]);
    const actionType = record.columns.ityp?.[0];
    const factor = record.columns.fact?.[0];
    loadCases.push({
      id: number,
      // A case that named itself is shown as it wrote itself; one that did not
      // is still a case, and its number is the only name it has.
      title: title || `Load case ${number}`,
      ...(kind ? { kind } : {}),
      ...(actionType ? { actionType } : {}),
      ...(Number.isFinite(factor) ? { factor } : {}),
      hasResults: true,
    });
  }
  return loadCases;
}

module.exports = { loadCaseKind, readLoadCases };
