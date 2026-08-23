const { fieldFactor } = require("./units");

// What a CDB was solved for, turned into what the Graviss contract asks for.
//
// Two questions, and they are separate on purpose: a model may name a hundred
// load cases and hold results for three, so listing them is cheap and reading
// one is not.

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

// Every load case the database names, with whether anything was computed for it.
// The numbers come from the key itself; everything else needs the record.
async function readLoadCases(database) {
  const numbers = Array.from(await database.keys("loadCase"));
  if (!numbers.length) return [];
  // Which cases hold node results, asked once rather than per case.
  const solved = new Set(Array.from(await database.keys("nodeResults")));
  const loadCases = [];
  for (const number of numbers) {
    const read = await database.read("loadCase", number, { partial: true });
    if (!read.count) continue;
    const title = read.columns.rtex?.[0];
    const kind = loadCaseKind(read.columns.kind?.[0]);
    const actionType = read.columns.ityp?.[0];
    const factor = read.columns.fact?.[0];
    loadCases.push({
      id: number,
      // A case that named itself is shown as it wrote itself; one that did not
      // is still a case, and its number is the only name it has.
      title: title || `Load case ${number}`,
      ...(kind ? { kind } : {}),
      ...(actionType ? { actionType } : {}),
      ...(Number.isFinite(factor) ? { factor } : {}),
      hasResults: solved.has(number),
    });
  }
  return loadCases;
}

// The displacement field of one load case.
//
// The nodes are named rather than assumed to be in the geometry's order: a
// result names its own nodes and the contract takes that, which is one fewer
// thing to keep in step between two reads of the same database.
async function readDisplacements(database, loadCaseId) {
  const read = await database.read("nodeResults", loadCaseId, { partial: true });
  const components = 6;
  const values = new Float32Array(read.count * components);
  const ids = new Array(read.count);
  const names = ["ux", "uy", "uz", "urx", "ury", "urz"];
  // One factor a column, from the quantity its own layout states: a deformation
  // and a rotation are different quantities and a release could store them in
  // different units.
  const factors = names.map((name) => fieldFactor(read, name));
  const columns = names.map((name) => read.columns[name]);
  let extent = 0;
  for (let index = 0; index < read.count; index += 1) {
    ids[index] = read.columns.nr[index];
    const at = index * components;
    for (let part = 0; part < components; part += 1) {
      values[at + part] = (columns[part]?.[index] ?? 0) * factors[part];
    }
    const resultant = Math.hypot(values[at], values[at + 1], values[at + 2]);
    if (resultant > extent) extent = resultant;
  }
  return { ids, values, components, extent };
}

// How a member bends between its ends, from the stations the solver wrote along
// it. The displacements are in the element's own local frame, which is why the
// contract asks an axial member to state its local axes.
//
// A station whose record continues the one before it belongs to the same
// element, which is what the reader's `element` column resolves.
async function readBeamStations(database, loadCaseId, elementIdOf) {
  const read = await database.read("beamForces", loadCaseId, { partial: true });
  if (!read.count) return [];
  const length = fieldFactor(read, "x");
  const move = fieldFactor(read, "ux");
  const turn = fieldFactor(read, "phix");
  const byElement = new Map();
  for (let index = 0; index < read.count; index += 1) {
    const number = read.columns.element?.[index] ?? read.columns.nr[index];
    const id = elementIdOf(number);
    if (id == null) continue;
    let stations = byElement.get(id);
    if (!stations) byElement.set(id, (stations = []));
    stations.push({
      x: (read.columns.x?.[index] ?? 0) * length,
      u: [
        (read.columns.ux?.[index] ?? 0) * move,
        (read.columns.uy?.[index] ?? 0) * move,
        (read.columns.uz?.[index] ?? 0) * move,
      ],
      phi: [
        (read.columns.phix?.[index] ?? 0) * turn,
        (read.columns.phiy?.[index] ?? 0) * turn,
        (read.columns.phiz?.[index] ?? 0) * turn,
      ],
    });
  }
  const elements = [];
  for (const [id, stations] of byElement) {
    // The solver writes them in order along the member, but a curve is only as
    // good as its ordering and sorting a handful of stations costs nothing.
    stations.sort((left, right) => left.x - right.x);
    elements.push({ id, stations });
  }
  return elements;
}

module.exports = {
  LOAD_CASE_KINDS,
  loadCaseKind,
  readBeamStations,
  readDisplacements,
  readLoadCases,
};
