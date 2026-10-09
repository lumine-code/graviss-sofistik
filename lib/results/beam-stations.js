const { fieldFactor } = require("@lumine-code/sofistik-reader");

// How a member bends between its ends, from the stations the solver wrote along
// it. The displacements are in the element's own local frame, which is why the
// contract asks an axial member to state its local axes.
//
// A station whose record continues the one before it belongs to the same
// element, which is what the reader's `element` column resolves.
async function readBeamStations(database, loadCaseId, elementIdOf) {
  const read = await database.read("beamForces", loadCaseId, { decodePolicy: "variable-tail" });
  if (!read.count) return [];
  // Force-only records stop at MT2. Missing deformations are not zero-valued
  // stations: leave member deformation to the nodal results in that case.
  if (!["ux", "uy", "uz"].every((name) => read.columns[name])) return [];
  const length = fieldFactor(read, "x");
  const move = fieldFactor(read, "ux");
  const turn = fieldFactor(read, "phix");
  const warp = fieldFactor(read, "phiw");
  const forceOnlyLengths = new Set(
    (read.provenance || [])
      .filter(({ partial }) => ["ux", "uy", "uz"].some((name) => partial?.dropped?.includes(name)))
      .map(({ length }) => length),
  );
  const byElement = new Map();
  for (let index = 0; index < read.count; index += 1) {
    if (forceOnlyLengths.has(read.recordLengths?.[index])) continue;
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
      warping: (read.columns.phiw?.[index] ?? 0) * warp,
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

module.exports = { readBeamStations };
