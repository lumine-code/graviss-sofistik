const {
  polygonShape,
  readNodes,
  readQuads,
  readSection,
  restraintsOf,
  roundShape,
} = require("../lib/model-geometry");

// The reader answers in columns, so the fixtures here are columns too.
function read(count, columns) {
  return { count, columns };
}

describe("readNodes", () => {
  it("keeps the model's coordinates and turns fixed degrees of freedom into supports", () => {
    const { nodes, supports, numbers } = readNodes(
      read(3, {
        nr: Int32Array.from([101, 102, -1]),
        xyz: Float32Array.from([0, 0, 0, 1.5, -2, 3, 9, 9, 9]),
        // KFIX names the degrees of freedom a node has, so a missing bit is a
        // restraint. 63 is free, 56 leaves the three displacements fixed.
        kfix: Int32Array.from([63, 56, 63]),
      }),
    );

    expect(nodes).toEqual([
      { id: 101, x: 0, y: 0, z: 0 },
      { id: 102, x: 1.5, y: -2, z: 3 },
    ]);
    expect(supports).toEqual([
      { id: "node-102", nodeId: 102, restraints: [true, true, true, false, false, false] },
    ]);
    expect(numbers).toEqual(new Set([101, 102]));
  });

  it("reads a free node as no support at all", () => {
    expect(restraintsOf(63)).toBeNull();
    expect(restraintsOf(0)).toEqual([true, true, true, true, true, true]);
  });
});

describe("readQuads", () => {
  it("reads a triangle as three corners and drops what it cannot resolve", () => {
    const numbers = new Set([1, 2, 3, 4]);
    const elements = readQuads(
      read(3, {
        nr: Int32Array.from([10, 11, 12]),
        // A triangle repeats its last corner; the third element names a node the
        // model does not have.
        node: Int32Array.from([1, 2, 3, 4, 1, 2, 3, 3, 1, 2, 99, 99]),
        mat: Int32Array.from([1, 1, 1]),
        thick: Float32Array.from([0.2, 0, 0, 0, 0, -0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        t: Float32Array.from(Array.from({ length: 27 }, (unused, index) => index % 9)),
      }),
      numbers,
    );

    expect(elements.map(({ id, nodeIds }) => ({ id, nodeIds }))).toEqual([
      { id: "quad-10", nodeIds: [1, 2, 3, 4] },
      { id: "quad-11", nodeIds: [1, 2, 3] },
    ]);
    // Stored as float32, so compared as float32.
    expect(elements[0].thickness).toBeCloseTo(0.2, 6);
    // A negative thickness is a sign convention, not a missing value.
    expect(elements[1].thickness).toBeCloseTo(0.3, 6);
    expect(elements[0].localAxes.x).toEqual([0, 1, 2]);
  });
});

describe("section shapes", () => {
  it("reads a circle, a ring and a tube out of the one record that carries them", () => {
    // The second int says which of the three the record describes.
    expect(
      roundShape(
        read(1, { ir: Int32Array.of(0), d: Float32Array.of(0.25), t: Float32Array.of(0) }),
      ),
    ).toEqual({
      kind: "circle",
      diameter: 0.5,
    });
    const ring = roundShape(
      read(1, { ir: Int32Array.of(1), d: Float32Array.of(0.25), t: Float32Array.of(0.2) }),
    );
    expect(ring.kind).toBe("tube");
    expect(ring.diameter).toBeCloseTo(0.5, 6);
    expect(ring.thickness).toBeCloseTo(0.05, 6);
    const tube = roundShape(
      read(1, { ir: Int32Array.of(2), d: Float32Array.of(0.4), t: Float32Array.of(0.05) }),
    );
    expect(tube.kind).toBe("tube");
    expect(tube.diameter).toBeCloseTo(0.4, 6);
    expect(tube.thickness).toBeCloseTo(0.05, 6);
    expect(
      roundShape(
        read(1, { ir: Int32Array.of(2), d: Float32Array.of(0.1), t: Float32Array.of(0.9) }),
      ),
    ).toBeNull();
    expect(roundShape(read(0, {}))).toBeNull();
  });

  it("takes the largest closed contour as the section outline", () => {
    // The properties int carries the contour number above its flag byte, and
    // only a boundary point describes the outline.
    const point = (contour, flag) => (contour << 8) | flag;
    const shape = polygonShape(
      read(9, {
        idp: Int32Array.from([
          point(1, 0),
          point(1, 0),
          point(1, 0),
          point(1, 0),
          point(2, 0),
          point(2, 0),
          point(2, 0),
          point(1, 7),
          point(1, 0),
        ]),
        y: Float32Array.from([0, 1, 1, 0, 5, 6, 5, 9, 0]),
        z: Float32Array.from([0, 0, 2, 2, 0, 0, 1, 9, 0]),
      }),
    );
    // The first contour has four corners and closes back on its first point,
    // which is dropped; the point flagged 7 is not on the boundary.
    expect(shape).toEqual({
      kind: "polygon",
      points: [
        [0, 0],
        [1, 0],
        [1, 2],
        [0, 2],
      ],
    });
  });

  it("falls back to the rectangle the section's own stiffness implies", () => {
    const section = readSection(
      12,
      read(1, {
        a: Float32Array.of(0.06),
        iy: Float32Array.of(0.00045),
        iz: Float32Array.of(0.0002),
        mno: Int32Array.of(3),
      }),
    );
    expect(section.id).toBe(12);
    expect(section.materialId).toBe(3);
    expect(section.shape.kind).toBe("rectangle");
    expect(section.shape.inferred).toBe(true);
    expect(section.shape.height).toBeCloseTo(0.3, 5);
    expect(section.shape.width).toBeCloseTo(0.2, 5);
  });
});
