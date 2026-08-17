const {
  polygonShape,
  readNodes,
  readQuads,
  readSection,
  readSprings,
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
        nra: Int32Array.from([1, 1, 1]),
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

describe("readQuads eccentricity", () => {
  // Four corners of a square in the XY plane, wound so the right-handed normal
  // of the node order is +Z.
  const nodesById = new Map([
    [1, { id: 1, x: 0, y: 0, z: 0 }],
    [2, { id: 2, x: 1, y: 0, z: 0 }],
    [3, { id: 3, x: 1, y: 1, z: 0 }],
    [4, { id: 4, x: 0, y: 1, z: 0 }],
  ]);
  const numbers = new Set([1, 2, 3, 4]);
  // Local z is +Z, so it agrees with the node order.
  const alignedAxes = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  // Local z is -Z, so it does not.
  const opposedAxes = [1, 0, 0, 0, -1, 0, 0, 0, -1];

  function quad(nra, axes = alignedAxes) {
    return readQuads(
      read(1, {
        nr: Int32Array.from([10]),
        node: Int32Array.from([1, 2, 3, 4]),
        mat: Int32Array.from([1]),
        nra: Int32Array.from([nra]),
        thick: Float32Array.from([0.4, 0, 0, 0, 0]),
        t: Float32Array.from(axes),
      }),
      numbers,
      nodesById,
    )[0];
  }

  it("reads an eccentricity flag as half a thickness off the node plane", () => {
    // A plain quad is meshed through its own middle and is not offset at all.
    expect(quad(1).offset).toBeUndefined();

    // Eccentric to one side or the other puts the element's surface half a
    // thickness away from the nodes, on that side.
    expect(quad(1 | 64).offset).toBeCloseTo(0.2, 6);
    expect(quad(1 | 128).offset).toBeCloseTo(-0.2, 6);

    // Claiming both is claiming neither: there is no side to pick.
    expect(quad(1 | 64 | 128).offset).toBeUndefined();
  });

  it("measures the eccentricity the way the viewer will", () => {
    // SOFiSTiK measures it along the element's stored local z and Graviss along
    // the right-handed normal of the node order. Where those oppose, passing
    // the distance through unchanged would offset the element the wrong way.
    expect(quad(1 | 64, opposedAxes).offset).toBeCloseTo(-0.2, 6);
    expect(quad(1 | 128, opposedAxes).offset).toBeCloseTo(0.2, 6);
  });

  it("has nothing to offset without a thickness", () => {
    const thin = readQuads(
      read(1, {
        nr: Int32Array.from([10]),
        node: Int32Array.from([1, 2, 3, 4]),
        mat: Int32Array.from([1]),
        nra: Int32Array.from([1 | 64]),
        thick: Float32Array.from([0, 0, 0, 0, 0]),
        t: Float32Array.from(alignedAxes),
      }),
      numbers,
      nodesById,
    )[0];
    expect(thin.offset).toBeUndefined();
  });
});

describe("readSprings", () => {
  const numbers = new Set([1, 2]);

  it("reads a spring between two nodes and one held against the ground", () => {
    const elements = readSprings(
      read(4, {
        nr: Int32Array.from([1, 2, 3, 0]),
        // The second node is zero for a grounded spring, and the fourth record
        // is not a spring at all.
        node: Int32Array.from([1, 2, 1, 0, 1, 0, 0, 0]),
        t: Float32Array.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
      }),
      numbers,
    );

    expect(elements.map(({ id, kind, nodeIds }) => ({ id, kind, nodeIds }))).toEqual([
      { id: "spring-1", kind: "spring", nodeIds: [1, 2] },
      { id: "spring-2", kind: "spring", nodeIds: [1] },
    ]);
    // A spring that spans two nodes needs no direction; one that does not is
    // drawn along the one it works in.
    expect(elements[0].direction).toBeUndefined();
    expect(elements[1].direction).toEqual([0, 0, 1]);
  });

  it("drops a grounded spring with no direction to draw it along", () => {
    const elements = readSprings(
      read(1, {
        nr: Int32Array.from([1]),
        node: Int32Array.from([1, 0]),
        t: Float32Array.from([0, 0, 0]),
      }),
      numbers,
    );
    expect(elements).toEqual([]);
  });
});
