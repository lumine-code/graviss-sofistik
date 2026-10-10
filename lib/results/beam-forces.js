const { fieldFactor } = require("@lumine-code/sofistik-reader");

const COMPONENTS = ["N", "Vy", "Vz", "Mt", "My", "Mz"];
const FIELDS = ["n", "vy", "vz", "mt", "my", "mz"];

// CDB 102/LC stores total internal forces (including plate components of a
// T-beam). STAR2 2026 section 2.2 defines positive forces and moments along the
// local right-handed axes on the positive face. That is Graviss's convention,
// so every sign is retained; this is not an end-node action-vector conversion.
async function readBeamForces(database, loadCaseId, elementIdOf) {
  const read = await database.read("beamForces", loadCaseId, { decodePolicy: "variable-tail" });
  const components = [...COMPONENTS];
  if (!read.count) return { components, elements: [] };

  // The documented short record ends after MT2. All six ordinary internal
  // forces are mandatory, even when none of the deformation tail is present.
  // Refuse missing data rather than inventing a zero force in its place.
  for (const name of ["x", ...FIELDS]) {
    if (!read.columns[name] || read.columns[name].length !== read.count) {
      throw new RangeError(`The CDB beam force result has no complete ${name} column.`);
    }
  }
  const lengthFactor = fieldFactor(read, "x");
  const factors = FIELDS.map((name) => fieldFactor(read, name));
  const byElement = new Map();
  for (let index = 0; index < read.count; index += 1) {
    // The reader resolves zero-numbered continuation records into `element`.
    const number = read.columns.element?.[index] ?? read.columns.nr?.[index];
    const id = elementIdOf(number);
    if (id == null) continue;
    const x = read.columns.x[index] * lengthFactor;
    const values = FIELDS.map((name, part) => read.columns[name][index] * factors[part]);
    if (!Number.isFinite(x) || values.some((value) => !Number.isFinite(value))) {
      throw new RangeError(`The CDB beam force result for ${id} contains a non-finite value.`);
    }
    let stations = byElement.get(id);
    if (!stations) byElement.set(id, (stations = []));
    stations.push({ x, values });
  }
  const elements = [];
  for (const [id, stations] of byElement) {
    // Stable sorting retains the solver's left/right order at a point load or
    // moment. Coincident stations are a discontinuity, never an average.
    stations.sort((left, right) => left.x - right.x);
    elements.push({ id, stations });
  }
  return { components, elements };
}

module.exports = { readBeamForces };
