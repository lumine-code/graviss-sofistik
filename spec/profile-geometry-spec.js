const { readSection } = require("../lib/geometry/sections");
const { cases } = require("./fixtures/profiles.json");

function polygonArea(points) {
  return (
    Math.abs(
      points.reduce((sum, [y, z], index) => {
        const [nextY, nextZ] = points[(index + 1) % points.length];
        return sum + y * nextZ - nextY * z;
      }, 0),
    ) / 2
  );
}

function plateCorners({ from, to, thickness }) {
  const y = to[0] - from[0];
  const z = to[1] - from[1];
  const half = thickness / (2 * Math.hypot(y, z));
  const dy = -z * half;
  const dz = y * half;
  return [
    [from[0] + dy, from[1] + dz],
    [to[0] + dy, to[1] + dz],
    [to[0] - dy, to[1] - dz],
    [from[0] - dy, from[1] - dz],
  ];
}

describe("PROF geometry from AQUA section records", () => {
  for (const fixture of cases) {
    it(`preserves the material and position of ${fixture.name}`, () => {
      const { expected } = fixture;
      const section = readSection(fixture.id, fixture.geometry);
      const shape = section.shape;
      expect(shape.kind).toBe(expected.kind);
      expect(shape.inferred).toBeUndefined();
      let materialArea;
      let points;
      if (shape.kind === "plates") {
        materialArea = shape.plates.reduce(
          (sum, { from, to, thickness }) =>
            sum + Math.hypot(to[0] - from[0], to[1] - from[1]) * thickness,
          0,
        );
        points = shape.plates.flatMap(plateCorners);
        const { wa, we } = fixture.geometry.panels.columns;
        expect(shape.plates.map((plate) => plate.unitWarping)).toEqual(
          wa.map((value, index) => [value, we[index]]),
        );
      } else {
        const parts = shape.parts || [shape];
        materialArea = parts.reduce(
          (sum, part) =>
            sum +
            polygonArea(part.points) -
            (part.holes || []).reduce((holes, hole) => holes + polygonArea(hole), 0),
          0,
        );
        points = parts.flatMap((part) => part.points);
        expect(parts.reduce((count, part) => count + (part.holes?.length || 0), 0)).toBe(
          expected.holes,
        );
      }
      // Circle contours use 128 chords; their area differs by 0.04016%.
      // AQUA's own clipped circular polygons can use coarser chords.
      const tolerance = expected.areaTolerance ?? (fixture.geometry.circle ? 0.0005 : 0.00001);
      expect(Math.abs(materialArea / expected.area - 1)).toBeLessThan(tolerance);
      for (const [axis, name] of ["y", "z"].entries()) {
        const values = points.map((point) => point[axis]);
        expect(Math.min(...values)).toBeCloseTo(expected.bounds[name][0], 7);
        expect(Math.max(...values)).toBeCloseTo(expected.bounds[name][1], 7);
      }
    });
  }
});
