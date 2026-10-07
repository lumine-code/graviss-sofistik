const { readNodes } = require("./geometry/nodes");
const { gravityVector } = require("./geometry/frames");
const {
  readBeams,
  readAxialElements,
  readQuads,
  readSprings,
  readCouplings,
} = require("./geometry/elements");
const { readSection } = require("./geometry/sections");
const { buildFilterTypes, readGroups, readSecondaryGroups } = require("./geometry/filters");

async function readOptional(read, fallback) {
  try {
    return await read();
  } catch (error) {
    if (error.code === "ERR_CDB_RECORD_UNAVAILABLE") return fallback;
    throw error;
  }
}

// The session snapshots the system record; native reads use described layouts
// and declared tails while this module assembles only the Graviss contract.
async function buildGeometry(database, gravityAxis, groupDivisor = 0) {
  const gravity = gravityVector(gravityAxis);
  const nodeRead = await database.read("nodes", undefined, { decodePolicy: "variable-tail" });
  const { nodes, supports, numbers } = readNodes(nodeRead);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const beamRead = await database.read("beams", undefined, { decodePolicy: "variable-tail" });
  const trussRead = await database.read("trusses", undefined, { decodePolicy: "variable-tail" });
  const cableRead = await database.read("cables", undefined, { decodePolicy: "variable-tail" });
  const quadRead = await database.read("quads", undefined, { decodePolicy: "variable-tail" });
  const springRead = await database.read("springs", undefined, { decodePolicy: "variable-tail" });
  const couplingRead = await readOptional(
    () => database.read("couplings", undefined, { decodePolicy: "variable-tail" }),
    { count: 0, columns: {} },
  );
  const elements = [
    ...readBeams(beamRead, numbers),
    ...readAxialElements(trussRead, numbers, nodesById, { kind: "truss", gravity }),
    ...readAxialElements(cableRead, numbers, nodesById, { kind: "cable", gravity }),
    ...readQuads(quadRead, numbers, nodesById),
    ...readSprings(springRead, numbers),
    ...readCouplings(couplingRead, numbers),
  ];

  const sections = [];
  for (const number of await database.keys("section")) {
    if (number <= 0) continue;
    sections.push(
      readSection(
        number,
        await database.read("section", number, { decodePolicy: "variable-tail" }),
      ),
    );
  }

  const groupRead = await readOptional(
    () => database.read("groups", undefined, { decodePolicy: "variable-tail" }),
    { count: 0, columns: {} },
  );
  const secondaryGroups = await readOptional(() => readSecondaryGroups(database, elements), null);
  const filterTypes = buildFilterTypes(
    elements,
    readGroups(groupRead),
    groupDivisor,
    secondaryGroups,
  );

  return {
    nodes,
    elements,
    supports,
    sections,
    ...(filterTypes.length ? { filterTypes } : {}),
  };
}

module.exports = { buildGeometry };
