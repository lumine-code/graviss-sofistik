const { fieldFactor } = require("@lumine-code/sofistik-reader");

// The displacement field of one load case.
//
// The nodes are named rather than assumed to be in the geometry's order: a
// result names its own nodes and the contract takes that, which is one fewer
// thing to keep in step between two reads of the same database.
async function readDisplacements(database, loadCaseId) {
  const read = await database.read("nodeResults", loadCaseId, { decodePolicy: "variable-tail" });
  const components = 7;
  const values = new Float32Array(read.count * components);
  const ids = new Array(read.count);
  // URB is SOFiSTiK's seventh beam degree of freedom: d(phi-x)/dx. Keeping it
  // beside the six ordinary displacements lets Graviss combine it with the
  // section's unit warping instead of silently drawing a six-DOF beam.
  const names = ["ux", "uy", "uz", "urx", "ury", "urz", "urb"];
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

module.exports = { readDisplacements };
