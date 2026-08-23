// Turns the records @lumine-code/sofistik-reader returns into the shapes the
// graviss.source contract asks for. Everything here is SOFiSTiK's model as it is
// stored: coordinates, local axes and section dimensions are passed through, and
// only the shape of the data changes.

const { packedText, secondaryGroupSelection } = require("@lumine-code/sofistik-reader/lib/results");

const DEGREES_OF_FREEDOM = 6;
// A quad's eccentricity is a flag on the element type rather than a distance:
// the nodes sit on one face of the slab instead of through its middle, so the
// element's own surface is half a thickness away from the plane it was meshed
// on. NRA carries both flags, and an element claiming neither or both is not
// eccentric at all.
const QUAD_ECCENTRIC_UPSIDE = 64;
const QUAD_ECCENTRIC_DOWNSIDE = 128;
const QUAD_ORTHOTROPIC = 256;
// The material of a section that is there and does not carry. Three bits name
// the action it is non-effective for - secondary bending, primary bending, the
// normal force - and any of them means the same thing to a picture. AQUA marks
// them on the plate or the polygon itself, splitting whatever the boundary
// runs through first, so a marked part is non-effective end to end and nothing
// has to be cut. They are the same three bits in a different order in the two
// records, which is why each names its own.
const PAN_NON_EFFECTIVE = 1024 | 2048 | 4096;
const PPT_NON_EFFECTIVE = 4 | 8 | 16;

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
      number: nr,
      kind: "beam",
      nodeIds: [start, end],
      localAxes: localAxes(read.columns.t, index),
    };
    const axis = read.columns.nref?.[index];
    if (Number.isFinite(axis) && axis > 0) element.referenceAxis = axis;
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
    const element = { id: `${kind}-${nr}`, number: nr, kind, nodeIds: [start, end] };
    const reference = read.columns.nref?.[index];
    if (Number.isFinite(reference) && reference > 0) element.referenceAxis = reference;
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
      number: nr,
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
    const element = { id: `spring-${nr}`, number: nr, kind: "spring", nodeIds: [start] };
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
      // A coupling constrains a node and has no element number of its own, so
      // it says which node rather than claiming a number the contract would
      // then let a user filter by.
      sourceNodeId: node,
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

// The polygons a section is drawn from, each with the points it was given and
// whether it is a hole and whether it carries. Read once, because the shape
// and the parts of it that do not count are two questions about one set of
// records.
function sectionPolygons(read) {
  const polygons = new Map();
  for (let index = 0; index < read.count; index += 1) {
    const idp = read.columns.idp[index];
    const number = idp >> 8;
    if (number <= 0) continue;
    const y = read.columns.y[index];
    const z = read.columns.z[index];
    if (!Number.isFinite(y) || !Number.isFinite(z)) continue;
    const entry = polygons.get(number) || {
      number,
      points: [],
      inner: false,
      nonEffective: true,
    };
    if ((idp & PPT_INNER_BOUNDARY) !== 0) entry.inner = true;
    // Every point of an area that does not carry says so, so one that does not
    // say it is enough to make the area count.
    if ((idp & PPT_NON_EFFECTIVE) === 0) entry.nonEffective = false;
    const last = entry.points.at(-1);
    if (!last || last[0] !== y || last[1] !== z) entry.points.push([y, z]);
    polygons.set(number, entry);
  }
  const closed = [...polygons.values()]
    .map((entry) => ({ ...entry, points: stripClosingPoint(entry.points) }))
    .filter((entry) => entry.points.length >= 3);
  const drawn = closed.filter((entry) => entry.number < PPT_GENERATED_POLYGON_START);
  return drawn.length ? drawn : closed;
}

function polygonShape(read) {
  if (!read?.count) return null;
  const usable = sectionPolygons(read);
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

// The plates a section is welded from, each with whether it carries. Read once
// for the same reason the polygons are.
function sectionPlates(read) {
  const { idp, ya, za, ye, ze, t } = read.columns;
  // A release that stored a shorter record leaves out the fields that did not
  // fit, and a plate is its two ends and a thickness or it is nothing at all.
  if (!ya || !za || !ye || !ze || !t) return [];
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
    if ((idp?.[index] & PAN_NON_EFFECTIVE) !== 0) plate.nonEffective = true;
    if ((idp?.[index] & PAN_GENERATED) !== 0) generated.push(plate);
    else plates.push(plate);
  }
  return plates.length ? plates : generated;
}

function platesShape(read) {
  if (!read?.count) return null;
  const usable = sectionPlates(read).map(({ from, to, thickness }) => ({ from, to, thickness }));
  return usable.length ? { kind: "plates", plates: usable } : null;
}

// The band a plate occupies: its line offset half a thickness either way,
// square at both ends. The shape hands the viewer the line and the thickness
// and lets it draw the band; an area that does not carry has to be the band
// itself, because that is what the contract asks a section to name.
function plateArea({ from, to, thickness }) {
  const runY = to[0] - from[0];
  const runZ = to[1] - from[1];
  const half = thickness / 2 / Math.hypot(runY, runZ);
  const offsetY = -runZ * half;
  const offsetZ = runY * half;
  return {
    points: [
      [from[0] + offsetY, from[1] + offsetZ],
      [to[0] + offsetY, to[1] + offsetZ],
      [to[0] - offsetY, to[1] - offsetZ],
      [from[0] - offsetY, from[1] - offsetZ],
    ],
  };
}

// The material a section carries in name only. AQUA is given the rule as a NEFF
// window or a NEFF strip and works it through the shape itself, splitting the
// plates and the polygons the boundary crosses and marking the pieces. Those
// marks are what a picture wants: they are already cut to the section, where
// the rule that made them is stated generously enough to reach past it.
//
// Read from whichever records the shape was read from, so the areas and the
// shape can never describe two different sections. The parametric shapes carry
// no marks of their own and get none.
function ineffectiveAreas(shape, read) {
  const areas = [];
  if (shape?.kind === "polygon" && read.polygon?.count) {
    for (const polygon of sectionPolygons(read.polygon)) {
      if (polygon.nonEffective && !polygon.inner) areas.push({ points: polygon.points });
    }
  }
  if (shape?.kind === "plates" && read.panels?.count) {
    for (const plate of sectionPlates(read.panels)) {
      if (plate.nonEffective) areas.push(plateArea(plate));
    }
  }
  return areas.length ? areas : null;
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
  const ineffective = ineffectiveAreas(shape, read);
  if (ineffective) section.ineffective = ineffective;
  if (read.count) {
    section.area = read.columns.a[0];
    section.materialId = read.columns.mno[0];
  }
  return section;
}

// Which group an element is in, from its own number.
//
// SOFiSTiK does not store the membership: the help states it as arithmetic, and
// the divisor is one field of the system record. With a divisor the group is
// the element number divided by it; without one every group holds an interval
// of numbers and its own record states where that interval starts. So the group
// records are read for their names and their extent, never to find out what is
// in them.
function groupOf(number, divisor, bases) {
  if (!Number.isFinite(number) || number <= 0) return null;
  if (divisor > 0) {
    const group = Math.floor(number / divisor);
    return group > 0 ? group : null;
  }
  // Sorted by where each group begins, so the one an element falls in is the
  // last that begins at or before it.
  let found = null;
  for (const { ng, min } of bases) {
    if (min > number) break;
    found = ng;
  }
  return found;
}

// The groups a model declares, whole records only: a group is written once
// entire and again for each element type it holds, and the short form carries
// no name.
function readGroups(read) {
  const groups = [];
  if (!read?.count) return groups;
  for (let index = 0; index < read.count; index += 1) {
    if (read.columns.typ?.[index] !== 0) continue;
    const ng = read.columns.ng[index];
    if (!Number.isFinite(ng)) continue;
    const title = read.columns.text?.[index];
    groups.push({ ng, min: read.columns.min?.[index] ?? 0, title: title || null });
  }
  groups.sort((left, right) => left.min - right.min);
  return groups;
}

// The dimensions this source divides a model along, and what each element holds
// of them. Graviss names none of these and filters by whatever it is handed, so
// everything SOFiSTiK-specific about a group stops here.
//
// Each type declares the kinds it turned out to be about, so the viewer can
// offer "Group (trusses)" only where the model can tell it apart - and numeric
// dimensions declare no value list at all: a range says what it means without
// one, and the reference axes alone would otherwise be hundreds of untitled
// value objects built purely to satisfy a validator.
function buildFilterTypes(elements, groups, divisor, secondaryGroups = null) {
  const filterTypes = [];
  const held = new Map();
  const hold = (element, key, value) => {
    held.set(element, { ...(held.get(element) || {}), [key]: value });
  };
  const kindsOf = (entries) => {
    const kinds = new Set();
    for (const [element] of entries) kinds.add(element.kind);
    return [...kinds].sort();
  };

  const grouped = [];
  for (const element of elements) {
    const group = groupOf(element.number, divisor, groups);
    if (group == null) continue;
    grouped.push([element, group]);
    hold(element, "group", group);
  }
  if (grouped.length) {
    // Titles only where the source actually named a group; most models name
    // none, and then there is no list at all.
    const named = groups.filter(({ title }) => title);
    filterTypes.push({
      id: "group",
      title: "Group",
      numeric: true,
      kinds: kindsOf(grouped),
      hint: "11, 12, 21-29",
      ...(named.length ? { values: named.map(({ ng, title }) => ({ id: ng, title })) } : {}),
    });
  }

  // The geometric line a member was generated along - the number SOFiMSHC shows
  // for it. A quad states no such thing, so this covers line elements and says
  // so by declaring only the kinds that held one.
  const axial = [];
  for (const element of elements) {
    const axis = element.referenceAxis;
    if (!Number.isFinite(axis) || axis <= 0) continue;
    axial.push([element, axis]);
    hold(element, "line", axis);
  }
  if (axial.length) {
    filterTypes.push({
      id: "line",
      title: "Structural line",
      numeric: true,
      kinds: kindsOf(axial),
      hint: "1030, 1040-1050",
    });
  }

  // Secondary groups, by the four-character names a user gives them. Unlike a
  // group, an element may be in several at once - the help is explicit - so the
  // dimension is many-valued and its values are names rather than numbers.
  if (secondaryGroups?.size) {
    const membership = [];
    for (const element of elements) {
      const names = secondaryGroups.get(element.number);
      if (!names?.length) continue;
      membership.push([element, names]);
      hold(element, "secondaryGroup", names);
    }
    if (membership.length) {
      const names = [...new Set([...secondaryGroups.values()].flat())].sort();
      filterTypes.push({
        id: "secondaryGroup",
        title: "Secondary group",
        multiple: true,
        kinds: kindsOf(membership),
        values: names.map((id) => ({ id })),
      });
    }
  }

  for (const [element, values] of held) element.filterValues = values;
  // `referenceAxis` is how a member said which axis it came from, and it is not
  // part of the contract - the filter type is.
  for (const element of elements) delete element.referenceAxis;
  return filterTypes;
}

// The gravity axis is the system record's, read once by the session that owns
// it: a member's default frame is measured against it, and reading it again
// here would ask the database twice for one number. The group divisor comes
// from the same record for the same reason.
async function buildGeometry(database, gravityAxis, groupDivisor = 0) {
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

  // Groups are read for their names; membership is arithmetic on the element
  // number. A reader pinned from before the group record was merged reports
  // only the whole records, which is exactly what is wanted here anyway.
  let groupRead = { count: 0, columns: {} };
  try {
    groupRead = await database.read("groups", undefined, { partial: true });
  } catch {
    // An older reader knows no group record; the model is still the model.
  }
  // Secondary groups are stored resolved: the list part is the calculated set
  // of element numbers, whatever boxes or rules produced it. Absent from most
  // models, and an older reader knows no such record - either way the model is
  // still the model.
  let secondaryGroups = null;
  try {
    secondaryGroups = await readSecondaryGroups(database);
  } catch {
    // Nothing to divide by; the other dimensions stand on their own.
  }
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

// Which secondary groups each element number is in, as a Map of number to the
// names that claim it. The record stores each group's calculated element list
// as signed run pairs, which the reader already knows how to unfold.
async function readSecondaryGroups(database) {
  const names = await database.keys("secondaryGroups");
  if (!names?.length) return null;
  const membership = new Map();
  for (const key of names) {
    const read = await database.read("secondaryGroups", key, { partial: true });
    const title = packedText(read.columns.id ?? []) || String(key);
    const numbers = read.columns.nr ?? [];
    const { ranges } = secondaryGroupSelection(numbers);
    for (const { from, to } of ranges) {
      for (let number = from; number <= to; number += 1) {
        const list = membership.get(number);
        if (list) list.push(title);
        else membership.set(number, [title]);
      }
    }
  }
  return membership.size ? membership : null;
}

module.exports = {
  buildFilterTypes,
  buildGeometry,
  groupOf,
  readGroups,
  defaultLocalAxes,
  ineffectiveAreas,
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
