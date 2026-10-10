const { fieldFactor } = require("@lumine-code/sofistik-reader");

// Mixed short/long CDB records share typed columns. A zero in the padded tail
// is not a stored zero; provenance resolves presence independently for each row.
function fieldsOf(read) {
  const descriptors = new Map((read.fields || []).map((field) => [field.name, field]));
  const missing = new Map(
    (read.provenance || []).map((entry) => [entry.length, new Set(entry.partial?.dropped || [])]),
  );
  const factors = new Map();
  return (name, row, part = null) => {
    const column = read.columns[name];
    if (!column || missing.get(read.recordLengths?.[row])?.has(name)) return null;
    const field = descriptors.get(name);
    const index = part == null ? row : row * (field?.count ?? 1) + part;
    const value = column[index];
    if (value == null) return null;
    if (!factors.has(name)) factors.set(name, fieldFactor(read, name));
    const converted = value * factors.get(name);
    if (!Number.isFinite(converted))
      throw new RangeError(
        `The CDB ${read.record || "member result"} ${name} field contains a non-finite value.`,
      );
    return converted;
  };
}

class MemberSeries {
  constructor() {
    this.components = new Map();
    this.members = new Map();
  }

  declare(descriptor) {
    if (!this.components.has(descriptor.id)) this.components.set(descriptor.id, descriptor);
    return descriptor.id;
  }

  add(elementId, x, descriptor, value) {
    this.declare(descriptor);
    if (!Number.isFinite(x))
      throw new RangeError(`The CDB member ${elementId} station is not finite.`);
    if (value !== null && !Number.isFinite(value))
      throw new RangeError(`The CDB member ${elementId} ${descriptor.id} value is not finite.`);
    let member = this.members.get(elementId);
    if (!member) this.members.set(elementId, (member = new Map()));
    let curve = member.get(descriptor.id);
    if (!curve) member.set(descriptor.id, (curve = []));
    curve.push({ x, value });
  }

  result() {
    const components = [...this.components.values()];
    const elements = [];
    for (const [id, member] of this.members) {
      const grid = new Map();
      for (const [component, curve] of member) {
        curve.sort((a, b) => a.x - b.x);
        let repeated = 0;
        let previous = null;
        for (const station of curve) {
          repeated = station.x === previous ? repeated + 1 : 1;
          if (repeated > 2)
            throw new RangeError(
              `The CDB ${id} ${component} has more than two values at x=${station.x}.`,
            );
          grid.set(station.x, Math.max(grid.get(station.x) || 0, repeated));
          previous = station.x;
        }
      }
      const positions = [...grid.keys()].sort((a, b) => a - b);
      const cursors = new Map();
      const stations = [];
      for (const x of positions) {
        for (let side = 0; side < grid.get(x); side += 1) {
          const values = components.map((descriptor) => {
            const curve = member.get(descriptor.id);
            if (!curve) return null;
            let cursor = cursors.get(descriptor.id) || 0;
            while (cursor < curve.length && curve[cursor].x < x) cursor += 1;
            cursors.set(descriptor.id, cursor);
            const next = curve[cursor];
            if (next?.x === x) {
              const second = curve[cursor + 1];
              return side && second?.x === x ? second.value : next.value;
            }
            if (descriptor.interpolation === "point") return null;
            const previous = curve[cursor - 1];
            if (!previous || !next || previous.value == null || next.value == null) return null;
            const t = (x - previous.x) / (next.x - previous.x);
            // Insert an existing curve's ordinate when another family sampled
            // a different grid. Do not extrapolate or bridge missing tails.
            return previous.value * (1 - t) + next.value * t;
          });
          stations.push({ x, values });
        }
      }
      elements.push({ id, stations });
    }
    return { components, elements };
  }
}

function sampleCurve(curve, x, side = 0) {
  if (!curve?.length) return null;
  let low = 0;
  let high = curve.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (curve[middle].x < x) low = middle + 1;
    else high = middle;
  }
  const next = curve[low];
  if (next?.x === x) return side && curve[low + 1]?.x === x ? curve[low + 1].value : next.value;
  const previous = curve[low - 1];
  if (!previous || !next || previous.value == null || next.value == null) return null;
  const t = (x - previous.x) / (next.x - previous.x);
  return previous.value * (1 - t) + next.value * t;
}

module.exports = { fieldsOf, MemberSeries, sampleCurve };
