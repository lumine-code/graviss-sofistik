const { restraintMask } = require("@lumine-code/sofistik-reader");
const DEGREES_OF_FREEDOM = 6;

// KFIX describes the degrees of freedom a node has. A missing bit is a rigid
// restraint; the bits above the sixth are solver bookkeeping, not directions.
function restraintsOf(fixity) {
  const mask = restraintMask(fixity);
  if (mask === 0) return null;
  return Array.from(
    { length: DEGREES_OF_FREEDOM },
    (unused, degree) => (mask & (1 << degree)) !== 0,
  );
}

function readNodes(read) {
  const nodes = [];
  const supports = [];
  const numbers = new Set();
  for (let index = 0; index < read.count; index += 1) {
    const nr = read.columns.nr[index];
    if (nr <= 0) continue;
    numbers.add(nr);
    const at = index * 3;
    nodes.push({
      id: nr,
      x: read.columns.xyz[at],
      y: read.columns.xyz[at + 1],
      z: read.columns.xyz[at + 2],
    });
    const restraints = restraintsOf(read.columns.kfix[index]);
    if (restraints) supports.push({ id: `node-${nr}`, nodeId: nr, restraints });
  }
  return { nodes, supports, numbers };
}

module.exports = { readNodes, restraintsOf };
