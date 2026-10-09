const { SHELL_FLAGS, couplingGroupOf, fieldFactor } = require("@lumine-code/sofistik-reader");
const { finitePositive } = require("./values");
const { unit, defaultLocalAxes } = require("./frames");
const {
  eccentricUpside: QUAD_ECCENTRIC_UPSIDE,
  eccentricDownside: QUAD_ECCENTRIC_DOWNSIDE,
  orthotropic: QUAD_ORTHOTROPIC,
} = SHELL_FLAGS;

function localAxes(transform, index) {
  const at = index * 9;
  return {
    x: [transform[at], transform[at + 1], transform[at + 2]],
    y: [transform[at + 3], transform[at + 4], transform[at + 5]],
    z: [transform[at + 6], transform[at + 7], transform[at + 8]],
  };
}
// A beam's first stored cross-section supplies the displayed profile.
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
      // SOFiSTiK Graphics shows each displaced finite beam as the straight
      // segment between its translated nodes. Station rotations still carry
      // section twist and warping, but do not turn that segment into a cubic.
      lineInterpolation: "linear",
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

// Axial members store no complete frame; derive it from their nodes and gravity.
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
      // SOFiSTiK Graphics displays a displaced QUAD by moving its corner nodes
      // and drawing the flat triangles between them. Its nodal rotations still
      // turn a thickness director, but are not surface slopes. State that here
      // rather than teaching the general viewer a SOFiSTiK-specific rule.
      surfaceInterpolation: "linear",
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
  const alongFactor = fieldFactor(read, "cp");
  const acrossFactor = fieldFactor(read, "cq");
  const aboutFactor = fieldFactor(read, "cm");
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
    if (along !== 0) element.stiffness = Math.abs(along) * alongFactor;
    if (across !== 0) element.transverseStiffness = Math.abs(across) * acrossFactor;
    if (about !== 0) element.rotationalStiffness = Math.abs(about) * aboutFactor;
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
    const group = couplingGroupOf(read.columns.ktl?.[index]);
    elements.push({
      id: `coupling-${pair}`,
      // A coupling constrains a node and has no element number of its own, so
      // it says which node rather than claiming a number the contract would
      // then let a user filter by.
      sourceNodeId: node,
      kind: "coupling",
      nodeIds: [node, reference],
      ...(group == null ? {} : { filterValues: { group } }),
    });
  }
  return elements;
}

module.exports = { readAxialElements, readBeams, readCouplings, readQuads, readSprings };
