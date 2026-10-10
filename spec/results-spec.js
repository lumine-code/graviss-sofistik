const { readLoadCases } = require("../lib/results/load-cases");
const { readBeamStations } = require("../lib/results/beam-stations");
const { readBeamForces } = require("../lib/results/beam-forces");

describe("SOFiSTiK results", () => {
  it("lists solved static cases and eigenmode records, not load definitions", async () => {
    const reads = [];
    const records = new Map([
      [
        101,
        {
          count: 1,
          columns: {
            kind: Int32Array.of(0),
            ityp: ["G_1"],
            fact: Float32Array.of(1),
            rtex: ["self-weight"],
          },
        },
      ],
      [
        10101,
        {
          count: 0,
          columns: {},
          eigenmode: {
            count: 1,
            columns: {
              kind: Int32Array.of(4),
              ityp: ["NONE"],
              nr_mode: Int32Array.of(1),
              omega: Float32Array.of(82.5),
              rtex: ["Eigenform  1    13.13 Hz"],
            },
          },
        },
      ],
    ]);
    const database = {
      async keys(name) {
        if (name === "loadCase") return Int32Array.from([101, 321, 10101]);
        if (name === "nodeResults") return Int32Array.from([101, 10101]);
        return new Int32Array(0);
      },
      async read(name, number) {
        reads.push([name, number]);
        return records.get(number) || { count: 0, columns: {} };
      },
    };

    expect(await readLoadCases(database)).toEqual([
      {
        id: 101,
        title: "self-weight",
        kind: "linear",
        actionType: "G_1",
        factor: 1,
        hasResults: true,
      },
      {
        id: 10101,
        title: "Eigenform  1    13.13 Hz",
        kind: "eigenmode",
        actionType: "NONE",
        hasResults: true,
      },
    ]);
    // LC 321 exists as a load definition but was never solved, so it costs no
    // record read and cannot appear as an empty choice in Results.
    expect(reads).toEqual([
      ["loadCase", 101],
      ["loadCase", 10101],
    ]);
  });
});

describe("solved superpositions", () => {
  it("lists the superposition variant returned under the load-case key", async () => {
    const database = {
      keys: async () => Int32Array.of(201),
      read: async () => ({
        count: 0,
        columns: {},
        superposition: { count: 1, columns: { kind: Int32Array.of(2), rtex: ["Envelope"] } },
      }),
    };
    expect(await readLoadCases(database)).toEqual([
      { id: 201, title: "Envelope", kind: "superposition", hasResults: true },
    ]);
  });

  it("includes force-only cases and lists a case with both fields only once", async () => {
    const database = {
      keys: async (name) =>
        ({
          loadCase: Int32Array.of(101, 201, 301, 401),
          nodeResults: Int32Array.of(101, 301),
          beamForces: Int32Array.of(201, 301),
        })[name],
      read: async (_name, number) => ({
        count: 1,
        columns: { kind: Int32Array.of(0), rtex: [`Case ${number}`] },
      }),
    };
    expect((await readLoadCases(database)).map(({ id }) => id)).toEqual([101, 201, 301]);
  });
});

describe("beam internal force stations", () => {
  function forceRead() {
    return {
      count: 4,
      fields: [
        { name: "x", unit: 1001 },
        { name: "n", unit: 1101 },
        { name: "vy", unit: 1102 },
        { name: "vz", unit: 1102 },
        { name: "mt", unit: 1103 },
        { name: "my", unit: 1104 },
        { name: "mz", unit: 1104 },
      ],
      // The short record lacks the entire deformation tail. A continuation
      // station has nr = 0 but the reader resolves its owning element.
      recordLengths: Int32Array.of(40, 40, 72, 72),
      provenance: [{ length: 40, partial: { dropped: ["ux", "uy", "uz"] } }],
      columns: {
        nr: Int32Array.of(12, 0, 0, 0),
        element: Int32Array.of(12, 12, 12, 12),
        x: Float32Array.of(0, 2, 2, 4),
        n: Float32Array.of(-4, -4, -4, -4),
        vy: Float32Array.of(1, 1, -3, -3),
        vz: Float32Array.of(2, 2, -2, -2),
        mt: Float32Array.of(-0.25, -0.25, 0.5, 0.5),
        my: Float32Array.of(0, 4, 4, 0),
        mz: Float32Array.of(0, -2, -2, 4),
      },
    };
  }

  const elementIdOf = (number) => (number > 0 ? `beam-${number}` : null);

  it("maps short and complete records to six signed SI components and preserves force jumps", async () => {
    const read = forceRead();
    const database = { read: jasmine.createSpy("read").and.resolveTo(read) };
    const result = await readBeamForces(database, 302, elementIdOf);
    expect(database.read).toHaveBeenCalledOnceWith("beamForces", 302, {
      decodePolicy: "variable-tail",
    });
    expect(result.components).toEqual(["N", "Vy", "Vz", "Mt", "My", "Mz"]);
    expect(result.elements).toEqual([
      {
        id: "beam-12",
        stations: [
          { x: 0, values: [-4000, 1000, 2000, -250, 0, 0] },
          { x: 2, values: [-4000, 1000, 2000, -250, 4000, -2000] },
          { x: 2, values: [-4000, -3000, -2000, 500, 4000, -2000] },
          { x: 4, values: [-4000, -3000, -2000, 500, 0, 4000] },
        ],
      },
    ]);
    expect(read.columns.ux).toBeUndefined();
  });

  it("sorts stations independently within each member without merging duplicate abscissae", async () => {
    const read = forceRead();
    read.columns.element = Int32Array.of(12, 13, 12, 12);
    read.columns.x = Float32Array.of(4, 1, 2, 2);
    const result = await readBeamForces({ read: async () => read }, 302, elementIdOf);
    expect(result.elements.map(({ id }) => id)).toEqual(["beam-12", "beam-13"]);
    expect(result.elements[0].stations.map(({ x }) => x)).toEqual([2, 2, 4]);
    expect(result.elements[0].stations.map(({ values }) => values[4])).toEqual([4000, 0, 0]);
  });

  it("converts the abscissa using its own quantity metadata", async () => {
    const read = forceRead();
    read.fields[0].unit = 1000;
    const result = await readBeamForces({ read: async () => read }, 302, elementIdOf);
    expect(result.elements[0].stations.at(-1).x).toBe(4000);
  });

  it("returns an empty field for a case without beam records", async () => {
    const result = await readBeamForces(
      { read: async () => ({ count: 0, columns: {} }) },
      302,
      elementIdOf,
    );
    expect(result.components).toEqual(["N", "Vy", "Vz", "Mt", "My", "Mz"]);
    expect(result.elements).toEqual([]);
  });

  for (const name of ["x", "n", "vy", "vz", "mt", "my", "mz"]) {
    it(`refuses a missing mandatory ${name} field instead of returning zero`, async () => {
      const read = forceRead();
      delete read.columns[name];
      await expectAsync(
        readBeamForces({ read: async () => read }, 302, elementIdOf),
      ).toBeRejectedWithError(new RegExp(`complete ${name} column`));
    });
  }

  it("refuses non-finite forces and unknown units", async () => {
    const read = forceRead();
    read.columns.my[1] = NaN;
    await expectAsync(
      readBeamForces({ read: async () => read }, 302, elementIdOf),
    ).toBeRejectedWithError(/non-finite/);
    read.columns.my[1] = 0;
    read.fields.find(({ name }) => name === "my").unit = 99999;
    await expectAsync(
      readBeamForces({ read: async () => read }, 302, elementIdOf),
    ).toBeRejectedWithError(/No SI conversion/);
  });
});

describe("beam deformation stations", () => {
  it("leaves a force-only beam record without deformation stations", async () => {
    const database = {
      read: async () => ({
        count: 2,
        columns: {
          element: Int32Array.of(110001, 110001),
          x: Float32Array.of(0, 2),
          n: Float32Array.of(-5, -5),
        },
      }),
    };
    expect(await readBeamStations(database, 302, (number) => `beam:${number}`)).toEqual([]);
  });

  it("keeps stored zero deformations and omits missing deformations when forms are mixed", async () => {
    const database = {
      read: async () => ({
        count: 3,
        fields: [
          { name: "x", unit: 1001 },
          { name: "ux", unit: 1003 },
          { name: "phix", unit: 1004 },
          { name: "phiw", unit: 1005 },
        ],
        recordLengths: Int32Array.of(40, 72, 72),
        provenance: [{ length: 40, partial: { dropped: ["ux", "uy", "uz"] } }],
        columns: {
          element: Int32Array.of(110001, 110002, 110002),
          x: Float32Array.of(0, 0, 2),
          ux: Float32Array.of(0, 0, 0),
          uy: Float32Array.of(0, 0, 1),
          uz: Float32Array.of(0, 0, 0),
        },
      }),
    };
    const result = await readBeamStations(database, 302, (number) => `beam:${number}`);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("beam:110002");
    expect(result[0].stations.length).toBe(2);
    expect(result[0].stations[0].u).toEqual([0, 0, 0]);
    expect(result[0].stations[1].u).toEqual([0, 1, 0]);
  });
});
