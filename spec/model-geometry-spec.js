const {
  buildGeometry,
  defaultLocalAxes,
  ineffectiveAreas,
  gravityVector,
  platesShape,
  polygonShape,
  readAxialElements,
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

  it("reads a thin-walled section as the plates it is welded from", () => {
    // Section 71 of the field model: a welded plate girder. The web stops at
    // the inner face of each flange and both flanges are split at the web, so
    // the bands abut and the plates tile the section exactly.
    const shape = platesShape(
      read(5, {
        idp: Int32Array.from([7, 7, 7, 7, 7]),
        ya: Float32Array.from([0, -0.13, 0, -0.13, 0]),
        za: Float32Array.from([-0.498, -0.5065, -0.5065, 0.5065, 0.5065]),
        ye: Float32Array.from([0, 0, 0.13, 0, 0.13]),
        ze: Float32Array.from([0.498, -0.5065, -0.5065, 0.5065, 0.5065]),
        t: Float32Array.from([0.01, 0.017, 0.017, 0.017, 0.017]),
      }),
    );
    expect(shape.kind).toBe("plates");
    expect(shape.plates.length).toBe(5);
    expect(shape.plates[0].thickness).toBeCloseTo(0.01, 6);
    expect(shape.plates[0].from[1]).toBeCloseTo(-0.498, 6);
    expect(shape.plates[0].to[1]).toBeCloseTo(0.498, 6);
    // The area the plates cover is the area the section has.
    const material = shape.plates.reduce(
      (total, { from, to, thickness }) =>
        total + Math.hypot(to[0] - from[0], to[1] - from[1]) * thickness,
      0,
    );
    expect(material).toBeCloseTo(0.0188, 5);
  });

  it("drops a plate with no thickness or no length, and has nothing to draw without one", () => {
    const plates = (t, ye) =>
      platesShape(
        read(1, {
          idp: Int32Array.of(0),
          ya: Float32Array.of(0),
          za: Float32Array.of(0),
          ye: Float32Array.of(ye),
          ze: Float32Array.of(0),
          t: Float32Array.of(t),
        }),
      );
    expect(plates(0.01, 0.5).plates.length).toBe(1);
    expect(plates(0, 0.5)).toBeNull();
    expect(plates(0.01, 0)).toBeNull();
    expect(platesShape(read(0, {}))).toBeNull();
    expect(platesShape(undefined)).toBeNull();
  });

  it("lets a generated plate stand in only when nothing was drawn", () => {
    const columns = (flags) =>
      read(flags.length, {
        idp: Int32Array.from(flags),
        ya: Float32Array.from(flags.map((unused, index) => index)),
        za: Float32Array.from(flags.map(() => 0)),
        ye: Float32Array.from(flags.map((unused, index) => index + 1)),
        ze: Float32Array.from(flags.map(() => 0)),
        t: Float32Array.from(flags.map(() => 0.01)),
      });
    // A plate SOFiSTiK generated repeats what was drawn, the same way a
    // generated polygon does.
    expect(platesShape(columns([7, 64])).plates.length).toBe(1);
    expect(platesShape(columns([64, 64])).plates.length).toBe(2);
  });

  it("reads the part of a section that does not carry as the area it stands in", () => {
    // AQUA splits a plate the non-effective boundary crosses and marks the
    // piece, so the mark is already cut to the section: the second plate here
    // is the lower half of a web, and the third is a flange.
    const panels = read(3, {
      idp: Int32Array.from([512, 1280, 1024]),
      ya: Float32Array.from([0, 0, -0.13]),
      za: Float32Array.from([-0.498, -0.2602, 0.5065]),
      ye: Float32Array.from([0, 0, 0.13]),
      ze: Float32Array.from([-0.2602, 0.498, 0.5065]),
      t: Float32Array.from([0.01, 0.01, 0.017]),
    });
    const shape = platesShape(panels);
    // The shape is still the whole section; the marks take nothing out of it.
    expect(shape.plates.length).toBe(3);
    expect("nonEffective" in shape.plates[1]).toBe(false);

    const areas = ineffectiveAreas(shape, { panels });
    expect(areas.length).toBe(2);
    // A plate's area is the band it occupies, which is what the shape has the
    // viewer draw from its line and its thickness.
    expect(areas[0].points.map((point) => point.map((value) => Number(value.toFixed(4))))).toEqual([
      [-0.005, -0.2602],
      [-0.005, 0.498],
      [0.005, 0.498],
      [0.005, -0.2602],
    ]);
    expect(areas[1].points.length).toBe(4);

    // A section nothing was taken out of says nothing.
    expect(
      ineffectiveAreas(shape, {
        panels: read(1, {
          idp: Int32Array.of(1),
          ya: Float32Array.of(0),
          za: Float32Array.of(-0.5),
          ye: Float32Array.of(0),
          ze: Float32Array.of(0.5),
          t: Float32Array.of(0.01),
        }),
      }),
    ).toBeNull();
    // Nor does a shape whose records carry no marks at all.
    expect(ineffectiveAreas({ kind: "rectangle" }, { panels })).toBeNull();
    expect(ineffectiveAreas(null, {})).toBeNull();
  });

  it("reads a polygon marked non-effective as the area it encloses", () => {
    // A composite deck whose slab is left out: every point of that polygon
    // carries the bits, and the polygons of the girder below it carry none.
    const point = (polygon, flag) => (polygon << 8) | flag;
    const polygon = read(9, {
      idp: Int32Array.from([
        point(1, 28),
        point(1, 28),
        point(1, 28),
        point(1, 156),
        point(3, 0),
        point(3, 0),
        point(3, 0),
        point(3, 0),
        point(3, 128),
      ]),
      y: Float32Array.from([-1, 1, 1, -1, -1, 1, 1, -1, -1]),
      z: Float32Array.from([-0.12, -0.12, 0, -0.12, -0.293, -0.293, -0.12, -0.12, -0.293]),
    });
    const shape = polygonShape(polygon);
    expect(shape.parts.length).toBe(2);

    const areas = ineffectiveAreas(shape, { polygon });
    expect(areas.length).toBe(1);
    expect(areas[0].points.length).toBe(3);
    expect(areas[0].points[0][1]).toBeCloseTo(-0.12, 6);
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
    // Only with nothing stored: a section that names its plates is read from
    // them rather than from the stiffness they add up to.
    const walled = readSection(12, {
      ...read(1, {
        a: Float32Array.of(0.06),
        iy: Float32Array.of(0.00045),
        iz: Float32Array.of(0.0002),
        mno: Int32Array.of(3),
      }),
      panels: read(1, {
        idp: Int32Array.of(7),
        ya: Float32Array.of(0),
        za: Float32Array.of(-0.15),
        ye: Float32Array.of(0),
        ze: Float32Array.of(0.15),
        t: Float32Array.of(0.01),
      }),
    });
    expect(walled.shape.kind).toBe("plates");
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

describe("readAxialElements", () => {
  const nodesById = new Map([
    [1, { id: 1, x: 0, y: 0, z: 0 }],
    [2, { id: 2, x: 4, y: 0, z: 0 }],
    [3, { id: 3, x: 4, y: 3, z: 0 }],
  ]);

  it("reads a truss or a cable as the span between its nodes, and the section it carries", () => {
    const columns = {
      // The third names a node the model does not have, the fourth spans one
      // node twice, and the fifth is not an element at all.
      nr: Int32Array.from([11, 12, 13, 14, 0]),
      node: Int32Array.from([1, 2, 2, 3, 1, 99, 2, 2, 0, 0]),
      nrq: Int32Array.from([52, 0, 52, 52, 52]),
    };
    const options = { kind: "truss", gravity: null };

    expect(readAxialElements(read(5, columns), new Set([1, 2, 3]), nodesById, options)).toEqual([
      { id: "truss-11", sourceId: 11, kind: "truss", nodeIds: [1, 2], sectionId: 52 },
      // A member naming no section is drawn on its centreline rather than
      // dropped: it is still a member, and the picture says what is known.
      { id: "truss-12", sourceId: 12, kind: "truss", nodeIds: [2, 3] },
    ]);

    // The two records are stored alike, so one reader serves both and only the
    // kind it is read as differs.
    expect(
      readAxialElements(read(1, columns), new Set([1, 2]), nodesById, {
        kind: "cable",
        gravity: null,
      }),
    ).toEqual([{ id: "cable-11", sourceId: 11, kind: "cable", nodeIds: [1, 2], sectionId: 52 }]);
  });

  it("gives an axial member the frame a beam of the same axis would have stored", () => {
    const [element] = readAxialElements(
      read(1, {
        nr: Int32Array.of(11),
        node: Int32Array.of(1, 2),
        nrq: Int32Array.of(52),
        // T is the axis alone, which the viewer already has from the two
        // nodes. There is no frame in the record to read.
        t: Float32Array.of(1, 0, 0),
      }),
      new Set([1, 2]),
      nodesById,
      { kind: "truss", gravity: [0, 0, 1] },
    );
    // The member runs along global x and gravity along global z, so the frame
    // is the identity - which is what the database stores for the beams
    // running the same way.
    expect(element.localAxes).toEqual({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
  });
});

describe("defaultLocalAxes", () => {
  it("turns a signed gravity axis into the direction gravity acts in", () => {
    expect(gravityVector(3)).toEqual([0, 0, 1]);
    expect(gravityVector(-2)).toEqual([0, -1, 0]);
    expect(gravityVector(1)).toEqual([1, 0, 0]);
    // A model whose system record says nothing usable has no down to measure
    // against, and a frame invented without one would be worse than none.
    expect(gravityVector(0)).toBeNull();
    expect(gravityVector(4)).toBeNull();
    expect(gravityVector(undefined)).toBeNull();
  });

  it("points the local z the way down looks in the member's own cross-section", () => {
    const gravity = [0, 0, 1];
    // Horizontal: z is gravity itself, exactly as the beams of the field
    // models store it.
    expect(defaultLocalAxes([1, 0, 0], gravity)).toEqual({
      x: [1, 0, 0],
      y: [0, 1, 0],
      z: [0, 0, 1],
    });
    expect(defaultLocalAxes([0, 1, 0], gravity)).toEqual({
      x: [0, 1, 0],
      y: [-1, 0, 0],
      z: [0, 0, 1],
    });

    // Sloping: gravity with the run along the member taken out of it. A real
    // beam of this axis stores y [0, 1, 0] and z [-0.8939, 0, 0.4483].
    const sloping = defaultLocalAxes([0.4483, 0, 0.8939], gravity);
    expect(sloping.y[0]).toBeCloseTo(0, 6);
    expect(sloping.y[1]).toBeCloseTo(1, 6);
    expect(sloping.z[0]).toBeCloseTo(-0.8939, 4);
    expect(sloping.z[2]).toBeCloseTo(0.4483, 4);

    // Reversing the member turns y round with it and leaves z alone, so a
    // section stands the same way up whichever end its nodes were given from.
    expect(defaultLocalAxes([-1, 0, 0], gravity)).toEqual({
      x: [-1, 0, 0],
      y: [0, -1, 0],
      z: [0, 0, 1],
    });
  });

  it("takes the limit for a member running along gravity", () => {
    // Straight down there is no y square to both, so the limit is taken in the
    // plane of gravity and the first global axis that is not gravity. The
    // columns of a real database store this frame.
    expect(defaultLocalAxes([0, 0, 1], [0, 0, 1])).toEqual({
      x: [0, 0, 1],
      y: [0, 1, 0],
      z: [-1, 0, 0],
    });
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
