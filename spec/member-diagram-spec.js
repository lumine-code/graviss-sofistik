const { readMemberDiagram } = require("../lib/results/member-diagram");
const { fieldsOf, MemberSeries } = require("../lib/results/member-series");
const { quantity } = require("../lib/results/member-quantities");

const empty = () => ({ count: 0, columns: {} });
const elementIdOf = (number) => (number > 0 ? `beam-${number}` : null);

function databaseOf(records) {
  return { read: async (name) => records[name] || empty() };
}

function field(result, id, element = "beam-12") {
  const index = result.components.findIndex((component) => component.id === id);
  expect(index).toBeGreaterThanOrEqual(0);
  return result.elements
    .find((entry) => entry.id === element)
    .stations.map((station) => station.values[index]);
}

function forces() {
  return {
    count: 2,
    fields: [
      ...["n", "vy", "vz"].map((name) => ({ name, unit: 1101 })),
      ...["mt", "my", "mz", "mt2", "mt3"].map((name) => ({ name, unit: 1103 })),
      { name: "mb", unit: 1105 },
      ...["pa", "pt", "pty", "ptz"].map((name) => ({ name, unit: 1095 })),
    ],
    columns: {
      nr: Int32Array.of(12, 0),
      element: Int32Array.of(12, 12),
      x: Float32Array.of(0, 4),
      n: Float32Array.of(-5, -5),
      vy: Float32Array.of(0, 0),
      vz: Float32Array.of(1, 1),
      mt: Float32Array.of(10, 10),
      my: Float32Array.of(-2, 2),
      mz: Float32Array.of(1, 1),
      mb: Float32Array.of(-2, 4),
      mt2: Float32Array.of(3, 3),
      mt3: Float32Array.of(1, 1),
      ux: Float32Array.of(0, 0.25),
      uy: Float32Array.of(0, 0.5),
      uz: Float32Array.of(0, -0.5),
      phix: Float32Array.of(0, 0.25),
      phiy: Float32Array.of(0, -0.25),
      phiz: Float32Array.of(0, 0.5),
      phiw: Float32Array.of(0, 0.25),
      pa: Float32Array.of(0, 3),
      pt: Float32Array.of(0, 5),
      pty: Float32Array.of(0, 3),
      ptz: Float32Array.of(0, 4),
    },
  };
}

describe("member quantity projection", () => {
  it("refuses influence coefficients instead of relabelling them as engineering deformations", async () => {
    await expectAsync(
      readMemberDiagram(
        databaseOf({
          loadCase: { count: 1, columns: { kind: Int32Array.of(3) } },
          beamForces: forces(),
        }),
        1,
        elementIdOf,
      ),
    ).toBeRejectedWithError(/influence coefficients/);
  });
  it("maps torsion decomposition, warping, deformations and bedding with their own dimensions", async () => {
    const result = await readMemberDiagram(databaseOf({ beamForces: forces() }), 1, elementIdOf);
    expect(field(result, "Mt1")).toEqual([6000, 6000]);
    expect(field(result, "Mb")).toEqual([-2000, 4000]);
    expect(field(result, "uy")).toEqual([0, 0.5]);
    expect(field(result, "phiy")).toEqual([0, -0.25]);
    expect(field(result, "phiw")).toEqual([0, 0.25]);
    expect(field(result, "pa")).toEqual([0, 3000]);
    expect(field(result, "pt")).toEqual([0, 5000]);
    expect(field(result, "pty")).toEqual([0, 3000]);
    expect(field(result, "ptz")).toEqual([0, 4000]);
    expect(result.components.find(({ id }) => id === "Mb")).toEqual(
      jasmine.objectContaining({ unit: "N·m²", displayUnit: "kN·m²", displayFactor: 0.001 }),
    );
    expect(result.components.find(({ id }) => id === "uy")).toEqual(
      jasmine.objectContaining({ unit: "m", displayUnit: "mm", displayFactor: 1000, plane: "y" }),
    );
    expect(result.components.find(({ id }) => id === "Mz").directionSign).toBe(-1);
  });

  it("distinguishes missing optional tails from actual stored zeros row by row", async () => {
    const read = forces();
    const dropped = [
      "ux",
      "uy",
      "uz",
      "phix",
      "phiy",
      "phiz",
      "phiw",
      "mt3",
      "pa",
      "pt",
      "pty",
      "ptz",
    ];
    read.recordLengths = Int32Array.of(40, 88);
    read.provenance = [{ length: 40, partial: { dropped } }, { length: 88 }];
    read.columns.ux[1] = 0;
    const result = await readMemberDiagram(databaseOf({ beamForces: read }), 1, elementIdOf);
    expect(field(result, "ux")).toEqual([null, 0]);
    expect(field(result, "Mt1")).toEqual([null, 6000]);
    expect(field(result, "Mt2")).toEqual([3000, 3000]);
    expect(field(result, "pt")).toEqual([null, 5000]);
  });

  it("keeps total and beam-only forces distinct", async () => {
    const beamOnly = forces();
    beamOnly.columns.n = Float32Array.of(-3, -3);
    const result = await readMemberDiagram(
      databaseOf({ beamForces: forces(), beamForcesWithoutPlate: beamOnly }),
      1,
      elementIdOf,
    );
    expect(field(result, "N")).toEqual([-5000, -5000]);
    expect(field(result, "beamOnly:N")).toEqual([-3000, -3000]);
  });

  it("exposes enhanced nodal-section modes separately when their documented tail exists", async () => {
    const read = forces();
    read.columns.alph_x = Float32Array.of(0.25, 0.5);
    read.columns.beta_y = Float32Array.of(0.125, 0.25);
    read.fields.push({ name: "alph_x", unit: 1003 }, { name: "beta_y", unit: 1004 });
    const result = await readMemberDiagram(databaseOf({ beamForces: read }), 1, elementIdOf);
    expect(field(result, "eas:alph_x")).toEqual([0.25, 0.5]);
    expect(field(result, "eas:beta_y")).toEqual([0.125, 0.25]);
    expect(field(result, "ux")).toEqual([0, 0.25]);
    expect(result.components.find(({ id }) => id === "eas:beta_y").unit).toBe("rad");
  });

  it("qualifies stress curves by material and preserves their separate station grids", async () => {
    const stresses = {
      count: 4,
      fields: [
        { name: "sigc", unit: 1092 },
        { name: "n_part", unit: 1101 },
      ],
      columns: {
        nr: Int32Array.of(12, 0, 0, 0),
        element: Int32Array.of(12, 12, 12, 12),
        mnr: Int32Array.of(1025, 1025, 1026, 1026),
        x: Float32Array.of(0, 4, 1, 3),
        sigc: Float32Array.of(-1000, -2000, -5000, -7000),
        n_part: Float32Array.of(-1, -2, -3, -4),
      },
    };
    const result = await readMemberDiagram(
      databaseOf({ beamForces: forces(), beamStresses: stresses }),
      1,
      elementIdOf,
    );
    expect(result.elements[0].stations.map(({ x }) => x)).toEqual([0, 1, 3, 4]);
    expect(field(result, "N")).toEqual([-5000, -5000, -5000, -5000]);
    expect(field(result, "stress:material:1:sigc")).toEqual([-1e6, -1.25e6, -1.75e6, -2e6]);
    expect(field(result, "stress:material:2:sigc")).toEqual([null, -5e6, -7e6, null]);
  });

  it("maps nonlinear hinges as point samples with force and deformation units", async () => {
    const hinges = {
      count: 2,
      fields: [
        { name: "stv", count: 11 },
        { name: "pidx", count: 6 },
      ],
      columns: {
        nr: Int32Array.of(12, 12),
        typ: Int32Array.of(15, 15),
        mtyp: Int32Array.of(1, 1),
        x: Float32Array.of(0, 4),
        reac: Float32Array.of(-2, 3),
        stv: Float32Array.from([
          0.5,
          -0.25,
          0.125,
          ...Array(8).fill(0),
          -0.5,
          -0.125,
          0.25,
          ...Array(8).fill(0),
        ]),
        pidx: Float32Array.from([0.5, 1, 2, 3, 4, 5, 0.25, 2, 3, 4, 5, 6]),
      },
    };
    const result = await readMemberDiagram(
      databaseOf({ beamHingeReactions: hinges }),
      1,
      elementIdOf,
    );
    expect(field(result, "hinge:My:reaction")).toEqual([-2000, 3000]);
    expect(field(result, "hinge:My:total")).toEqual([0.5, -0.5]);
    expect(field(result, "hinge:My:plasticNegative")).toEqual([-0.25, -0.125]);
    expect(field(result, "hinge:My:performance0")).toEqual([0.5, 0.25]);
    expect(result.components.find(({ id }) => id === "hinge:My:reaction")).toEqual(
      jasmine.objectContaining({ interpolation: "point", unit: "N·m" }),
    );
  });

  it("breaks thrust-line curves at an axial-force zero instead of connecting opposite infinities", async () => {
    const read = forces();
    read.columns.n = Float32Array.of(-5, 5);
    const result = await readMemberDiagram(databaseOf({ beamForces: read }), 1, elementIdOf);
    expect(result.elements[0].stations.map(({ x }) => x)).toEqual([0, 2, 4]);
    expect(field(result, "thrust:y")).toEqual([0.2, null, -0.2]);
    expect(field(result, "N")).toEqual([-5000, 0, 5000]);
  });

  it("distinguishes elastic-centre and reference-axis thrust using stored section offsets", async () => {
    const section = {
      count: 2,
      columns: {
        nr: Int32Array.of(12, 12),
        x: Float32Array.of(0, 4),
        ys: Float32Array.of(0.5, 0.5),
        zs: Float32Array.of(0.25, 0.25),
        e0: Float32Array.of(0.125, 0.25),
      },
    };
    const result = await readMemberDiagram(
      databaseOf({ beamForces: forces(), beamStiffness: section }),
      1,
      elementIdOf,
    );
    expect(field(result, "thrust:y")).toEqual([0.2, 0.2]);
    expect(field(result, "thrustAxis:y")).toEqual([0.7, 0.7]);
    expect(field(result, "thrustAxis:z")).toEqual([0.65, -0.15000000000000002]);
    expect(field(result, "section:e0")).toEqual([0.125, 0.25]);
  });

  it("converts explicit stiffness and curvature units and implicit crack-width units", async () => {
    const section = {
      count: 1,
      fields: [
        { name: "ea", unit: 62 },
        { name: "eiy", unit: 83 },
        { name: "gkpy", unit: 17 },
        { name: "ccw", unit: 1026 },
        { name: "e0", unit: 1081 },
      ],
      columns: {
        nr: Int32Array.of(12),
        x: Float32Array.of(1),
        ea: Float32Array.of(2000),
        eiy: Float32Array.of(30),
        gkpy: Float32Array.of(0.25),
        ccw: Float32Array.of(0.125),
        e0: Float32Array.of(0.5),
      },
    };
    const result = await readMemberDiagram(databaseOf({ beamStiffness: section }), 1, elementIdOf);
    expect(field(result, "section:ea")).toEqual([2e6]);
    expect(field(result, "section:eiy")).toEqual([30000]);
    expect(field(result, "section:gkpy")).toEqual([0.25]);
    expect(field(result, "section:ccw")).toEqual([0.125]);
    expect(field(result, "section:e0")).toEqual([0.5]);
  });

  it("omits explicitly unavailable families but propagates decoder failures", async () => {
    const unavailable = Object.assign(new Error("No record in this release"), {
      code: "ERR_CDB_RECORD_UNAVAILABLE",
    });
    const database = {
      read: async (name) => {
        if (name === "beamHingeReactions") throw unavailable;
        return name === "beamForces" ? forces() : empty();
      },
    };
    expect((await readMemberDiagram(database, 1, elementIdOf)).elements.length).toBe(1);
    delete unavailable.code;
    await expectAsync(readMemberDiagram(database, 1, elementIdOf)).toBeRejectedWithError(
      "No record in this release",
    );
  });

  it("resolves a negative explicit element number independently of a previous continuation", async () => {
    const read = forces();
    read.columns.nr = Int32Array.of(-13, 13);
    read.columns.element = Int32Array.of(12, 13);
    const result = await readMemberDiagram(databaseOf({ beamForces: read }), 1, elementIdOf);
    expect(result.elements.map(({ id }) => id)).toEqual(["beam-13"]);
  });
});

describe("member station grid merging", () => {
  it("preserves discontinuity banks when a second family inserts a station", () => {
    const series = new MemberSeries();
    const a = quantity("a", "A", "Test", "force");
    const b = quantity("b", "B", "Test", "force", "y", 1, "point");
    for (const [x, value] of [
      [0, 0],
      [2, 2],
      [2, -2],
      [4, 0],
    ])
      series.add("beam-12", x, a, value);
    series.add("beam-12", 1, b, 7);
    const result = series.result();
    expect(field(result, "a")).toEqual([0, 1, 2, -2, 0]);
    expect(field(result, "b")).toEqual([null, 7, null, null, null]);
  });

  it("never interpolates through a missing record or between point samples", () => {
    const series = new MemberSeries();
    const a = quantity("a", "A", "Test", "force");
    const b = quantity("b", "B", "Test", "force", "y", 1, "point");
    for (const [x, value] of [
      [0, 1],
      [2, null],
      [4, 5],
    ])
      series.add("beam-12", x, a, value);
    for (const [x, value] of [
      [1, 2],
      [3, 4],
    ])
      series.add("beam-12", x, b, value);
    const result = series.result();
    expect(field(result, "a")).toEqual([1, null, null, null, 5]);
    expect(field(result, "b")).toEqual([null, 2, null, 4, null]);
  });

  it("refuses ambiguous triples instead of averaging independent values", () => {
    const series = new MemberSeries();
    const a = quantity("a", "A", "Test", "force");
    for (const value of [1, 2, 3]) series.add("beam-12", 0, a, value);
    expect(() => series.result()).toThrowError(/more than two values/);
  });

  it("uses array field stride and row presence independently", () => {
    const read = {
      count: 2,
      fields: [{ name: "stv", count: 3 }],
      recordLengths: Int32Array.of(24, 36),
      provenance: [{ length: 24, partial: { dropped: ["stv"] } }],
      columns: { stv: Float32Array.of(0, 0, 0, 1, 2, 3) },
    };
    const value = fieldsOf(read);
    expect(value("stv", 0, 1)).toBeNull();
    expect(value("stv", 1, 1)).toBe(2);
  });
});
