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
const QUAD_ORTHOTROPIC = 256;

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

function cross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function unit(vector) {
  const length = Math.hypot(...vector);
  // The `+ 0` turns a negative zero back into a zero. A cross product yields
  // one wherever a term cancels; it is the same number and a different value,
  // and it has no business in geometry a viewer and a saved document read.
  return length > 1e-9 ? vector.map((value) => value / length + 0) : null;
}

// IACHS names the signed global axis gravity acts along, and the model's own
// axes are the ones a frame is built in.
function gravityVector(gravityAxis) {
  const axis = Math.abs(gravityAxis);
  if (!Number.isInteger(gravityAxis) || axis < 1 || axis > 3) return null;
  const vector = [0, 0, 0];
  vector[axis - 1] = Math.sign(gravityAxis);
  return vector;
}

// The frame SOFiSTiK gives a member that nothing rotates: local y square to
// both the member and gravity, and local z completing the right-handed set —
// which is to say z is which way is down, seen in the member's own
// cross-section. Checked against the beams of the three field models, which do
// store their frame: 4870 of 5146 agree, and every one that does not carries an
// explicit roll in BETY or BETZ, a field a truss record does not have.
//
// A member running along gravity has no such y, so the limit is taken in the
// plane of gravity and the first global axis that is not gravity — for a
// gravity-down model, the global y, which is what the columns of a real
// database store.
function defaultLocalAxes(axis, gravity) {
  const other = [0, 0, 0];
  other[(gravity.findIndex((value) => value !== 0) + 1) % 3] = 1;
  const y = unit(cross(gravity, axis)) || unit(cross(gravity, other));
  const z = y && unit(cross(axis, y));
  return z ? { x: axis, y, z } : null;
}

// A truss and a cable are stored alike and read alike: a number, the two nodes
// they span, and the cross-section they carry.
//
// Neither stores a local frame the way a beam does — its T is the axis alone,
// which is the run between its nodes and nothing the viewer does not already
// have — because an axial member has no bending for a section orientation to
// matter to. But the section still has to be drawn some way up, and the way up
// SOFiSTiK means is the one it stores for a beam of the same axis. So the frame
// is computed by that rule rather than left to the viewer, which would roll a
// double-angle onto its back beside the beams it braces.
function readAxialElements(read, numbers, nodesById, { kind, gravity }) {
  const elements = [];
  for (let index = 0; index < read.count; index += 1) {
    const nr = read.columns.nr[index];
    const start = read.columns.node[index * 2];
    const end = read.columns.node[index * 2 + 1];
    if (nr <= 0 || start === end || !numbers.has(start) || !numbers.has(end)) continue;
    const element = { id: `${kind}-${nr}`, sourceId: nr, kind, nodeIds: [start, end] };
    // The axis is taken from the node order rather than from T, because the
    // node order is what the viewer measures the member along; a frame built on
    // the other one would be mirrored wherever the two disagreed.
    const from = nodesById?.get(start);
    const to = nodesById?.get(end);
    const axis = gravity && from && to ? unit([to.x - from.x, to.y - from.y, to.z - from.z]) : null;
    const axes = axis && defaultLocalAxes(axis, gravity);
    if (axes) element.localAxes = axes;
    const section = read.columns.nrq?.[index];
    if (section > 0) element.sectionId = section;
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

// The nodes sit on one face of the plate, so the element's own surface is half
// a thickness away from them — and on a plate that tapers, half of a different
// thickness at every corner. One distance for all of them would hold the thin
// corners off the very nodes they were meshed on.
function quadOffset(nra, thickness, axes, corners) {
  const upside = (nra & QUAD_ECCENTRIC_UPSIDE) !== 0;
  const downside = (nra & QUAD_ECCENTRIC_DOWNSIDE) !== 0;
  if (upside === downside) return 0;
  // "Upside" is the physical above. SOFiSTiK's global z follows gravity and a
  // quad's local z follows global z, so above is against local z rather than
  // along it — verified against SOFiSTiK's own viewer on an eccentric wall,
  // the constant's name alone reading either way.
  const sign = (upside ? -1 : 1) * (normalAgreesWithLocalZ(axes, corners) ? 1 : -1);
  if (Array.isArray(thickness)) return thickness.map((value) => (sign * value) / 2);
  if (!finitePositive(thickness)) return 0;
  return (sign * thickness) / 2;
}

// THICK holds five values: the middle thickness first, then the thickness at
// each of the four nodes — unless the orthotropic bit is set, in which case the
// last four are orthotropic stiffnesses and only the middle is a thickness, or
// a node slot is negative, in which case it names a plate-stiffness section
// rather than measuring anything. Node slots left at zero mean a plate of one
// thickness, stored once in the middle. Verified against a real database: an
// eccentric tapering wall stores middle 0.2207 with nodes 0.2265, 0.215,
// 0.215, 0.2265.
function quadThickness(read, index, cornerSlots, nra) {
  const at = index * 5;
  const middle = Math.abs(read.columns.thick[at]);
  const fallback = finitePositive(middle) ? middle : null;
  if ((nra & QUAD_ORTHOTROPIC) !== 0) return fallback;
  const values = cornerSlots.map((slot) => read.columns.thick[at + 1 + slot]);
  if (!values.length || !values.every(finitePositive)) return fallback;
  return values.every((value) => value === values[0]) ? values[0] : values;
}

function readQuads(read, numbers, nodesById) {
  const elements = [];
  for (let index = 0; index < read.count; index += 1) {
    const nr = read.columns.nr[index];
    if (nr <= 0) continue;
    const nodeIds = [];
    // The raw slot each kept corner came from, because the node thicknesses
    // are stored by slot: a triangle repeats its last corner, and its kept
    // corners are slots 0, 1 and 2 of four.
    const cornerSlots = [];
    for (let corner = 0; corner < 4; corner += 1) {
      const node = read.columns.node[index * 4 + corner];
      // A node the model does not have is not a corner at all.
      if (node > 0 && numbers.has(node) && !nodeIds.includes(node)) {
        nodeIds.push(node);
        cornerSlots.push(corner);
      }
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
    const thickness = quadThickness(read, index, cornerSlots, read.columns.nra[index]);
    if (thickness != null) element.thickness = thickness;
    const offset = quadOffset(
      read.columns.nra[index],
      thickness,
      axes,
      nodeIds.map((nodeId) => nodesById?.get(nodeId)),
    );
    if (Array.isArray(offset) ? offset.some((value) => value !== 0) : offset) {
      element.offset = offset;
    }
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
    // CP acts along the spring's own direction and CQ across it; CM acts about
    // it. A spring with only the torsional stiffness resists rotation and
    // nothing else, which is a different thing to draw — anything holding a
    // translation as well is drawn as the coil it mostly is.
    const along = read.columns.cp?.[index] || 0;
    const across = read.columns.cq?.[index] || 0;
    const about = read.columns.cm?.[index] || 0;
    if (about !== 0 && along === 0 && across === 0) element.rotational = true;
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

// A coupling is a kinematic constraint rather than an element: a node held to
// a reference node, stored under the node key. KTL packs the kind of constraint
// with the depth and the group it belongs to, and the kind is the low two
// digits — but which kind it is says what the constraint does to the degrees of
// freedom, not whether there are two nodes to draw between. What decides that
// is whether it names a reference node other than itself, which the ones tying
// a node to a symmetry plane or a cyclic sector do not.
function readCouplings(read, numbers) {
  const elements = [];
  const seen = new Set();
  for (let index = 0; index < read.count; index += 1) {
    const node = read.columns.nr[index];
    const reference = read.columns.kr[index * 2];
    if (node <= 0 || reference <= 0 || node === reference) continue;
    if (!numbers.has(node) || !numbers.has(reference)) continue;
    // One pair of nodes is coupled once however many degrees of freedom say so,
    // and a model constrains all six of them as six records.
    const pair = node < reference ? `${node}-${reference}` : `${reference}-${node}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    elements.push({
      id: `coupling-${pair}`,
      sourceId: node,
      kind: "coupling",
      nodeIds: [node, reference],
    });
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

// Polygon points carry their polygon number in the high bits of IDP and a
// flag byte below it. Bit 1 marks an inner boundary — a hole — and bit 128 the
// closing vertex, which repeats the first. The rest of the byte is bookkeeping
// about effectiveness, fillets and generation; none of it moves a point, so
// every point is kept whatever it carries. The old reading treated those bits
// as unknown flags and dropped the points wearing them, which lost whole
// areas; it then kept a single polygon of the survivors, which lost the rest
// of a composed section — a plate, a deck and the web between them are three
// polygons of one section.
const PPT_INNER_BOUNDARY = 1;
// Polygons numbered from 100 are generated by the FEM mesh and repeat the
// drawn ones; they stand in only when nothing else is there.
const PPT_GENERATED_POLYGON_START = 100;

function polygonShape(read) {
  if (!read?.count) return null;
  const polygons = new Map();
  for (let index = 0; index < read.count; index += 1) {
    const idp = read.columns.idp[index];
    const number = idp >> 8;
    if (number <= 0) continue;
    const y = read.columns.y[index];
    const z = read.columns.z[index];
    if (!Number.isFinite(y) || !Number.isFinite(z)) continue;
    const entry = polygons.get(number) || { number, points: [], inner: false };
    if ((idp & PPT_INNER_BOUNDARY) !== 0) entry.inner = true;
    const last = entry.points.at(-1);
    if (!last || last[0] !== y || last[1] !== z) entry.points.push([y, z]);
    polygons.set(number, entry);
  }
  const closed = [...polygons.values()]
    .map((entry) => ({ ...entry, points: stripClosingPoint(entry.points) }))
    .filter((entry) => entry.points.length >= 3);
  const drawn = closed.filter((entry) => entry.number < PPT_GENERATED_POLYGON_START);
  const usable = drawn.length ? drawn : closed;
  const outers = usable
    .filter((entry) => !entry.inner)
    .sort((left, right) => left.number - right.number);
  if (!outers.length) return null;
  const parts = outers.map((entry) => ({ points: entry.points }));
  // A hole belongs to the area it lies inside; one lying in none describes
  // nothing that is drawn.
  for (const hole of usable.filter((entry) => entry.inner)) {
    const target = outers.findIndex((outer) => pointInPolygon(hole.points[0], outer.points));
    if (target < 0) continue;
    (parts[target].holes ||= []).push(hole.points);
  }
  if (parts.length === 1) {
    const only = parts[0];
    const shape = { kind: "polygon", points: only.points };
    if (only.holes) shape.holes = only.holes;
    return shape;
  }
  return { kind: "polygon", parts };
}

function stripClosingPoint(points) {
  const first = points[0];
  const last = points.at(-1);
  return points.length > 1 && first[0] === last[0] && first[1] === last[1]
    ? points.slice(0, -1)
    : points;
}

// Even-odd ray casting, enough to say which area a hole lies inside.
function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [ay, az] = polygon[i];
    const [by, bz] = polygon[j];
    if (az > point[1] !== bz > point[1]) {
      const crossing = ((by - ay) * (point[1] - az)) / (bz - az) + ay;
      if (point[0] < crossing) inside = !inside;
    }
  }
  return inside;
}

// A thin-walled section is stored as the plates it is welded from: each one a
// run from (ya,za) to (ye,ze) with a thickness, and the run is the plate's
// middle. SOFiSTiK trims them so their bands abut - a girder's web stops at the
// inner face of each flange - so they are passed through as they are stored.
//
// The welds stored beside them are not part of the section. A weld spans the
// gap a plate was trimmed by, so drawing one would put material back where the
// section deliberately has none, and the stored area agrees: it counts the
// plates and not the welds.
//
// A plate SOFiSTiK generated stands in only when nothing was drawn, the same
// rule the generated polygons follow.
const PAN_GENERATED = 64;

function platesShape(read) {
  if (!read?.count) return null;
  const { idp, ya, za, ye, ze, t } = read.columns;
  // A release that stored a shorter record leaves out the fields that did not
  // fit, and a plate is its two ends and a thickness or it is nothing at all.
  if (!ya || !za || !ye || !ze || !t) return null;
  const plates = [];
  const generated = [];
  for (let index = 0; index < read.count; index += 1) {
    const thickness = t[index];
    const from = [ya[index], za[index]];
    const to = [ye[index], ze[index]];
    if (!finitePositive(thickness)) continue;
    if (![...from, ...to].every(Number.isFinite)) continue;
    if (from[0] === to[0] && from[1] === to[1]) continue;
    const plate = { from, to, thickness };
    if ((idp?.[index] & PAN_GENERATED) !== 0) generated.push(plate);
    else plates.push(plate);
  }
  const usable = plates.length ? plates : generated;
  return usable.length ? { kind: "plates", plates: usable } : null;
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
    platesShape(read.panels) ||
    inferredShape(read);
  if (shape) section.shape = shape;
  if (read.count) {
    section.area = read.columns.a[0];
    section.materialId = read.columns.mno[0];
  }
  return section;
}

// The gravity axis is the system record's, read once by the session that owns
// it: a member's default frame is measured against it, and reading it again
// here would ask the database twice for one number.
async function buildGeometry(database, gravityAxis) {
  const gravity = gravityVector(gravityAxis);
  const nodeRead = await database.read("nodes", undefined, { partial: true });
  const { nodes, supports, numbers } = readNodes(nodeRead);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const beamRead = await database.read("beams", undefined, { partial: true });
  const trussRead = await database.read("trusses", undefined, { partial: true });
  const cableRead = await database.read("cables", undefined, { partial: true });
  const quadRead = await database.read("quads", undefined, { partial: true });
  const springRead = await database.read("springs", undefined, { partial: true });
  // A coupling is an addition to the picture, never a prerequisite for it. The
  // record was named in the reader long after the others, so a reader pinned
  // from before that refuses the read — and the model is still the model
  // without its couplings. Nothing else is read after this, so the breadth of
  // the catch hides no failure the other reads would not have thrown first.
  let couplingRead = { count: 0, columns: {} };
  try {
    couplingRead = await database.read("couplings", undefined, { partial: true });
  } catch {
    // An older reader knows no couplings record; there is nothing to read.
  }
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
    sections.push(readSection(number, await database.read("section", number, { partial: true })));
  }
  return { nodes, elements, supports, sections };
}

module.exports = {
  buildGeometry,
  defaultLocalAxes,
  gravityVector,
  platesShape,
  polygonShape,
  readAxialElements,
  readCouplings,
  readBeams,
  readNodes,
  readQuads,
  readSection,
  readSprings,
  restraintsOf,
  roundShape,
};
