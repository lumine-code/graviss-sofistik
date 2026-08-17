const {
  buildGeometry,
  polygonShape,
  readNodes,
  readCouplings,
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

  it("keeps every polygon of a composed section, and every point of each", () => {
    // IDP carries the polygon number above a flag byte. The flags are
    // bookkeeping — effectiveness, fillets, generation, the closing vertex —
    // and none of them moves a point. Section 11 of the field model is the
    // shape of the bug this pins: a plate whose points carry effectiveness
    // bits, a deck of another material, and the web between them. Dropping
    // flagged points lost the plate; keeping one polygon lost the rest.
    const point = (polygon, flag) => (polygon << 8) | flag;
    const shape = polygonShape(
      read(17, {
        idp: Int32Array.from([
          point(1, 28),
          point(1, 28),
          point(1, 28),
          point(1, 92),
          point(1, 92),
          point(1, 28),
          point(1, 156),
          point(3, 0),
          point(3, 0),
          point(3, 0),
          point(3, 0),
          point(3, 128),
          point(4, 0),
          point(4, 0),
          point(4, 0),
          point(4, 0),
          point(4, 128),
        ]),
        y: Float32Array.from([
          -1, 1, 1, 0.13, -0.13, -1, -1, -1, 1, 1, -1, -1, -0.13, 0.13, 0.16, -0.16, -0.13,
        ]),
        z: Float32Array.from([
          -0.12, -0.12, 0, 0, 0, 0, -0.12, -0.293, -0.293, -0.12, -0.12, -0.293, 0, 0, 0.72, 0.72,
          0,
        ]),
      }),
    );
    expect(shape.kind).toBe("polygon");
    expect(shape.parts.length).toBe(3);
    expect(shape.parts.map((part) => part.points.length)).toEqual([6, 4, 4]);
    // The closing vertex repeats the first and is dropped; the flagged points
    // in the middle of the plate are kept, corners like any other. Stored as
    // float32, so compared as float32.
    expect(shape.parts[0].points[3][0]).toBeCloseTo(0.13, 6);
    expect(shape.parts[0].points[3][1]).toBe(0);
  });

  it("reads an inner boundary as a hole of the area it lies inside", () => {
    const point = (polygon, flag) => (polygon << 8) | flag;
    const shape = polygonShape(
      read(8, {
        idp: Int32Array.from([
          point(1, 0),
          point(1, 0),
          point(1, 0),
          point(1, 0),
          point(2, 1),
          point(2, 1),
          point(2, 1),
          point(2, 129),
        ]),
        y: Float32Array.from([0, 4, 4, 0, 1, 2, 1, 1]),
        z: Float32Array.from([0, 0, 4, 4, 1, 1, 2, 1]),
      }),
    );
    expect(shape.points.length).toBe(4);
    expect(shape.holes.length).toBe(1);
    expect(shape.holes[0].length).toBe(3);
    expect("parts" in shape).toBe(false);
  });

  it("lets a generated polygon stand in only when nothing was drawn", () => {
    const point = (polygon, flag) => (polygon << 8) | flag;
    const columns = (polygons) =>
      read(polygons.length * 3, {
        idp: Int32Array.from(
          polygons.flatMap((number) => [point(number, 0), point(number, 0), point(number, 0)]),
        ),
        y: Float32Array.from(polygons.flatMap((number) => [number, number + 1, number])),
        z: Float32Array.from(polygons.flatMap(() => [0, 0, 1])),
      });
    // Polygons numbered from 100 repeat the drawn ones and are left out.
    expect(polygonShape(columns([1, 100])).points.length).toBe(3);
    expect("parts" in polygonShape(columns([1, 100]))).toBe(false);
    // With nothing drawn they are all there is, and better than nothing.
    expect(polygonShape(columns([100])).points.length).toBe(3);
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

    // Eccentric one way or the other puts the element's surface half a
    // thickness away from the nodes — "upside" being the physical above, which
    // in a gravity-down frame is against local z.
    expect(quad(1 | 64).offset).toBeCloseTo(-0.2, 6);
    expect(quad(1 | 128).offset).toBeCloseTo(0.2, 6);

    // Claiming both is claiming neither: there is no side to pick.
    expect(quad(1 | 64 | 128).offset).toBeUndefined();
  });

  it("measures the eccentricity the way the viewer will", () => {
    // SOFiSTiK measures it along the element's stored local z and Graviss along
    // the right-handed normal of the node order. Where those oppose, passing
    // the distance through unchanged would offset the element the wrong way.
    expect(quad(1 | 64, opposedAxes).offset).toBeCloseTo(0.2, 6);
    expect(quad(1 | 128, opposedAxes).offset).toBeCloseTo(-0.2, 6);
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

describe("readQuads thickness", () => {
  const nodesById = new Map([
    [1, { id: 1, x: 0, y: 0, z: 0 }],
    [2, { id: 2, x: 1, y: 0, z: 0 }],
    [3, { id: 3, x: 1, y: 1, z: 0 }],
    [4, { id: 4, x: 0, y: 1, z: 0 }],
  ]);
  const numbers = new Set([1, 2, 3, 4]);

  function quad(thick, nra = 1) {
    return readQuads(
      read(1, {
        nr: Int32Array.from([10]),
        node: Int32Array.from([1, 2, 3, 4]),
        mat: Int32Array.from([1]),
        nra: Int32Array.from([nra]),
        thick: Float32Array.from(thick),
        t: Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      }),
      numbers,
      nodesById,
    )[0];
  }

  it("reads the middle thickness and the four node thicknesses behind it", () => {
    // THICK stores the middle value first and the node values after it. A
    // plate of one thickness stores it once, in the middle.
    expect(quad([0.3, 0, 0, 0, 0]).thickness).toBeCloseTo(0.3, 6);
    // Node values all saying the same thing are that one thickness.
    expect(quad([0.3, 0.3, 0.3, 0.3, 0.3]).thickness).toBeCloseTo(0.3, 6);

    // Unequal node values are an element that tapers, and every corner is
    // carried — reading the middle as a corner shifted the whole run by one
    // and turned a continuous taper into steps.
    const tapered = quad([0.4, 0.2, 0.2, 0.6, 0.6]).thickness;
    expect(tapered.length).toBe(4);
    expect(tapered[0]).toBeCloseTo(0.2, 6);
    expect(tapered[2]).toBeCloseTo(0.6, 6);

    // With the orthotropic bit set the four are stiffnesses, not thicknesses.
    expect(quad([0.3, 9, 9, 9, 9], 1 | 256).thickness).toBeCloseTo(0.3, 6);

    // A negative node slot names a plate-stiffness section rather than
    // measuring anything, so only the middle is a thickness.
    expect(quad([0.3, -12, 0.2, 0.2, 0.2]).thickness).toBeCloseTo(0.3, 6);

    // No thickness at all is an element with none, not one of nothing.
    expect(quad([0, 0, 0, 0, 0]).thickness).toBeUndefined();
  });

  it("makes a tapering element eccentric by half of each of its corners", () => {
    // The nodes sit on one face of the plate, so the surface is half a
    // thickness away from them — and on a plate that tapers, half of a
    // different thickness at every corner.
    const offset = quad([0.4, 0.2, 0.2, 0.6, 0.6], 1 | 64).offset;
    expect(offset.length).toBe(4);
    expect(offset[0]).toBeCloseTo(-0.1, 6);
    expect(offset[2]).toBeCloseTo(-0.3, 6);

    // A plate of one thickness is eccentric by one distance, as it always was.
    expect(quad([0.4, 0, 0, 0, 0], 1 | 64).offset).toBeCloseTo(-0.2, 6);
    expect(quad([0.4, 0, 0, 0, 0], 1 | 128).offset).toBeCloseTo(0.2, 6);
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
        cp: Float32Array.from([1000, 0, 0, 0]),
        cq: Float32Array.from([0, 0, 0, 0]),
        cm: Float32Array.from([0, 0, 500, 0]),
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
    // A spring holding a translation is drawn as the coil it is; the kind is
    // only read the other way for one that holds nothing but a rotation.
    expect(elements[0].rotational).toBeUndefined();
    expect(elements[1].rotational).toBeUndefined();
  });

  it("reads a spring that resists only rotation as one that turns", () => {
    const elements = readSprings(
      read(2, {
        nr: Int32Array.from([1, 2]),
        node: Int32Array.from([1, 2, 1, 2]),
        t: Float32Array.from([0, 0, 1, 0, 0, 1]),
        // The first holds a rotation and nothing else; the second holds both,
        // and a coil is the truer picture of that.
        cp: Float32Array.from([0, 1000]),
        cq: Float32Array.from([0, 0]),
        cm: Float32Array.from([500, 500]),
      }),
      numbers,
    );
    expect(elements[0].rotational).toBe(true);
    expect(elements[1].rotational).toBeUndefined();
  });

  it("drops a grounded spring with no direction to draw it along", () => {
    const elements = readSprings(
      read(1, {
        nr: Int32Array.from([1]),
        node: Int32Array.from([1, 0]),
        t: Float32Array.from([0, 0, 0]),
        cp: Float32Array.from([1000]),
        cq: Float32Array.from([0]),
        cm: Float32Array.from([0]),
      }),
      numbers,
    );
    expect(elements).toEqual([]);
  });
});

describe("buildGeometry", () => {
  it("builds the model without couplings when the reader knows none", async () => {
    // The couplings record was named in the reader long after the others, so a
    // reader pinned from before that refuses the read. The model is still the
    // model without its couplings.
    const empty = { count: 0, columns: {} };
    const database = {
      async read(name) {
        if (name === "couplings") throw new Error('Unknown SOFiSTiK record "couplings".');
        if (name === "nodes") {
          return {
            count: 1,
            columns: {
              nr: Int32Array.of(1),
              xyz: Float32Array.of(0, 0, 0),
              kfix: Int32Array.of(0),
            },
          };
        }
        return empty;
      },
      async keys() {
        return [];
      },
    };
    const geometry = await buildGeometry(database);
    expect(geometry.nodes.length).toBe(1);
    expect(geometry.elements).toEqual([]);
  });
});

describe("readCouplings", () => {
  const numbers = new Set([1, 2, 3]);

  it("reads a constrained node and the node it is held to", () => {
    const elements = readCouplings(
      read(5, {
        // KTL packs the kind with the depth and the group; every kind that
        // names a partner is a coupling to draw.
        ktl: Int32Array.from([1, 2, 3, 31, 8]),
        nr: Int32Array.from([1, 1, 2, 3, 1]),
        // A constraint tying a node to a symmetry plane names no partner, and
        // one naming a node the model does not have names nothing either.
        kr: Int32Array.from([2, 0, 2, 3, 0, 0, 0, 0, 99, 0]),
      }),
      numbers,
    );

    expect(elements.map(({ id, kind, nodeIds }) => ({ id, kind, nodeIds }))).toEqual([
      { id: "coupling-1-2", kind: "coupling", nodeIds: [1, 2] },
    ]);
  });

  it("draws one link between a pair however many degrees of freedom tie it", () => {
    // Six constrained degrees of freedom is six records and one coupling.
    const elements = readCouplings(
      read(6, {
        ktl: Int32Array.from([1, 2, 3, 4, 5, 6]),
        nr: Int32Array.from([1, 1, 1, 1, 1, 1]),
        kr: Int32Array.from([2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0]),
      }),
      numbers,
    );
    expect(elements.length).toBe(1);
    // And the pair reads the same whichever end was constrained.
    const mirrored = readCouplings(
      read(2, {
        ktl: Int32Array.from([1, 1]),
        nr: Int32Array.from([1, 2]),
        kr: Int32Array.from([2, 0, 1, 0]),
      }),
      numbers,
    );
    expect(mirrored.map(({ id }) => id)).toEqual(["coupling-1-2"]);
  });
});
