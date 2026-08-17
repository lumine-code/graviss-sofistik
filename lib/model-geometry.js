// Turns the records @lumine-code/sofistik-reader returns into the shapes the
// graviss.source contract asks for. Everything here is SOFiSTiK's model as it is
// stored: coordinates, local axes and section dimensions are passed through, and
// only the shape of the data changes.

const DEGREES_OF_FREEDOM = 6;
// A quad's eccentricity is a flag on the element type rather than a distance:
// the nodes sit on one face of the slab instead of through its middle, so the
// element's own surface is half a thickness away from the plane it was meshed
// on. NRA carries both flags, and an element claiming neither or both is not
// eccentric at all.
const QUAD_ECCENTRIC_UPSIDE = 64;
const QUAD_ECCENTRIC_DOWNSIDE = 128;

function finitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

function localAxes(transform, index) {
  const at = index * 9;
  return {
    x: [transform[at], transform[at + 1], transform[at + 2]],
    y: [transform[at + 3], transform[at + 4], transform[at + 5]],
    z: [transform[at + 6], transform[at + 7], transform[at + 8]],
  };
}

// KFIX describes the degrees of freedom a node has. A missing bit is a rigid
// restraint; the bits above the sixth are solver bookkeeping, not directions.
function restraintsOf(fixity) {
  const mask = ~fixity & 63;
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

// A beam's cross-sections are stored under the beam they belong to. The first
// one is the beam's profile; the rest describe stations along a tapered beam.
function sectionsByBeam(read) {
  const sections = new Map();
  const part = read.sections;
  if (!part) return sections;
  for (let index = 0; index < part.count; index += 1) {
    const beam = part.owners[index];
    const section = part.columns.nq[index];
    if (part.columns.id[index] !== 0 || section <= 0 || sections.has(beam)) continue;
    sections.set(beam, section);
  }
  return sections;
}

function readBeams(read, numbers) {
  const profiles = sectionsByBeam(read);
  const elements = [];
  for (let index = 0; index < read.count; index += 1) {
    const nr = read.columns.nr[index];
    const start = read.columns.node[index * 2];
    const end = read.columns.node[index * 2 + 1];
    if (nr <= 0 || start === end || !numbers.has(start) || !numbers.has(end)) continue;
    const element = {
      id: `beam-${nr}`,
      sourceId: nr,
      kind: "beam",
      nodeIds: [start, end],
      localAxes: localAxes(read.columns.t, index),
    };
    const section = profiles.get(nr);
    if (section) element.sectionId = section;
    elements.push(element);
  }
  return elements;
}

// SOFiSTiK measures the eccentricity along the element's stored local z, and
// Graviss measures an offset along the right-handed normal of the node order.
// The two normally agree, and where they do not the offset would be applied to
// the wrong face, so the provider reconciles them rather than the viewer
// guessing which convention it was handed.
function normalAgreesWithLocalZ(axes, corners) {
  const [origin, next, last] = corners;
  if (!origin || !next || !last) return true;
  const edge = [next.x - origin.x, next.y - origin.y, next.z - origin.z];
  const other = [last.x - origin.x, last.y - origin.y, last.z - origin.z];
  const normal = [
    edge[1] * other[2] - edge[2] * other[1],
    edge[2] * other[0] - edge[0] * other[2],
    edge[0] * other[1] - edge[1] * other[0],
  ];
  const along = normal[0] * axes.z[0] + normal[1] * axes.z[1] + normal[2] * axes.z[2];
  return along >= 0;
}

function quadOffset(nra, thickness, axes, corners) {
  if (!finitePositive(thickness)) return 0;
  const upside = (nra & QUAD_ECCENTRIC_UPSIDE) !== 0;
  const downside = (nra & QUAD_ECCENTRIC_DOWNSIDE) !== 0;
  if (upside === downside) return 0;
  const distance = (upside ? thickness : -thickness) / 2;
  return normalAgreesWithLocalZ(axes, corners) ? distance : -distance;
}

function readQuads(read, numbers, nodesById) {
  const elements = [];
  for (let index = 0; index < read.count; index += 1) {
    const nr = read.columns.nr[index];
    if (nr <= 0) continue;
    const nodeIds = [];
    for (let corner = 0; corner < 4; corner += 1) {
      const node = read.columns.node[index * 4 + corner];
      // A triangle repeats its last corner, and a node the model does not have
      // is not a corner at all.
      if (node > 0 && numbers.has(node) && !nodeIds.includes(node)) nodeIds.push(node);
    }
    if (nodeIds.length < 3) continue;
    const axes = localAxes(read.columns.t, index);
    const element = {
      id: `quad-${nr}`,
      sourceId: nr,
      kind: "shell",
      nodeIds,
      materialId: read.columns.mat[index],
      localAxes: axes,
    };
    const thickness = Math.abs(read.columns.thick[index * 5]);
    if (finitePositive(thickness)) element.thickness = thickness;
    const offset = quadOffset(
      read.columns.nra[index],
      thickness,
      axes,
      nodeIds.map((nodeId) => nodesById?.get(nodeId)),
    );
    if (offset) element.offset = offset;
    elements.push(element);
  }
  return elements;
}

// A spring joins two nodes, or holds one against the ground and says which way
// it acts. Both shapes are what the record stores: the second node is zero for
// a grounded spring, and the normal direction is what it works along.
function readSprings(read, numbers) {
  const elements = [];
  for (let index = 0; index < read.count; index += 1) {
    const nr = read.columns.nr[index];
    if (nr <= 0) continue;
    const start = read.columns.node[index * 2];
    const end = read.columns.node[index * 2 + 1];
    if (!numbers.has(start)) continue;
    const element = { id: `spring-${nr}`, sourceId: nr, kind: "spring", nodeIds: [start] };
    if (end > 0 && end !== start && numbers.has(end)) {
      element.nodeIds.push(end);
    } else {
      const at = index * 3;
      const direction = [read.columns.t[at], read.columns.t[at + 1], read.columns.t[at + 2]];
      // Held against the ground with no direction of its own is a spring
      // nothing can be drawn for, since it has neither a span nor a way to
      // point.
      if (!direction.every(Number.isFinite) || direction.every((value) => value === 0)) continue;
      element.direction = direction;
    }
    elements.push(element);
  }
  return elements;
}

function rectangleShape(read) {
  if (!read?.count) return null;
  const height = read.columns.h[0];
  const width = read.columns.b[0];
  if (!finitePositive(width) || !finitePositive(height)) return null;
  const type = read.columns.iq[0];
  const flangeThickness = read.columns.ho?.[0];
  const flangeWidth = read.columns.bo?.[0];
  if (
    (type === 2 || type === 3) &&
    finitePositive(flangeThickness) &&
    finitePositive(flangeWidth)
  ) {
    return { kind: "tee", webWidth: width, height, flangeWidth, flangeThickness };
  }
  return { kind: "rectangle", width, height };
}

// One record carries a circle, a ring or a tube, and its second int says which.
function roundShape(read) {
  if (!read?.count) return null;
  const type = read.columns.ir[0];
  const diameter = read.columns.d[0];
  const thickness = read.columns.t[0];
  if (type === 0 || type === 1) {
    if (!finitePositive(diameter) || thickness < 0 || thickness >= diameter) return null;
    return thickness > 0
      ? { kind: "tube", diameter: diameter * 2, thickness: diameter - thickness }
      : { kind: "circle", diameter: diameter * 2 };
  }
  if (type === 2) {
    if (!finitePositive(diameter) || !finitePositive(thickness) || thickness * 2 >= diameter) {
      return null;
    }
    return { kind: "tube", diameter, thickness };
  }
  if (type === 3 && finitePositive(diameter)) return { kind: "circle", diameter };
  return null;
}

// Polygon points carry their contour number and a flag in one int; only boundary
// points describe the outline.
function polygonShape(read) {
  if (!read?.count) return null;
  const contours = new Map();
  for (let index = 0; index < read.count; index += 1) {
    const properties = read.columns.idp[index];
    const flags = properties & 0xff;
    const contour = properties >> 8;
    const y = read.columns.y[index];
    const z = read.columns.z[index];
    if (contour <= 0 || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (flags !== 0 && flags !== 64 && flags !== 128) continue;
    const points = contours.get(contour) || [];
    const last = points.at(-1);
    if (!last || last[0] !== y || last[1] !== z) points.push([y, z]);
    contours.set(contour, points);
  }
  const closed = [...contours.values()]
    .map((points) => {
      const first = points[0];
      const last = points.at(-1);
      return points.length > 1 && first[0] === last[0] && first[1] === last[1]
        ? points.slice(0, -1)
        : points;
    })
    .filter((points) => points.length >= 3)
    .sort((left, right) => right.length - left.length);
  return closed.length ? { kind: "polygon", points: closed[0] } : null;
}

// With no shape stored, the section's own area and inertias still describe a
// rectangle of the same stiffness, which is enough to draw it.
function inferredShape(read) {
  if (!read?.count) return null;
  const area = read.columns.a[0];
  const inertiaY = read.columns.iy[0];
  const inertiaZ = read.columns.iz[0];
  if (!finitePositive(area) || !finitePositive(inertiaY) || !finitePositive(inertiaZ)) return null;
  return {
    kind: "rectangle",
    width: Math.sqrt((12 * inertiaZ) / area),
    height: Math.sqrt((12 * inertiaY) / area),
    inferred: true,
  };
}

function readSection(number, read) {
  const section = { id: number, name: `Section ${number}` };
  const shape =
    rectangleShape(read.rectangle) ||
    roundShape(read.tube) ||
    polygonShape(read.polygon) ||
    inferredShape(read);
  if (shape) section.shape = shape;
  if (read.count) {
    section.area = read.columns.a[0];
    section.materialId = read.columns.mno[0];
  }
  return section;
}

async function buildGeometry(database) {
  const nodeRead = await database.read("nodes", undefined, { partial: true });
  const { nodes, supports, numbers } = readNodes(nodeRead);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const beamRead = await database.read("beams", undefined, { partial: true });
  const quadRead = await database.read("quads", undefined, { partial: true });
  const springRead = await database.read("springs", undefined, { partial: true });
  const elements = [
    ...readBeams(beamRead, numbers),
    ...readQuads(quadRead, numbers, nodesById),
    ...readSprings(springRead, numbers),
  ];

  const sections = [];
  for (const number of await database.keys("section")) {
    if (number <= 0) continue;
    sections.push(readSection(number, await database.read("section", number, { partial: true })));
  }
  return { nodes, elements, supports, sections };
}

module.exports = {
  buildGeometry,
  polygonShape,
  readBeams,
  readNodes,
  readQuads,
  readSection,
  readSprings,
  restraintsOf,
  roundShape,
};
