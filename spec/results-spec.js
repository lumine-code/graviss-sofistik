const { readLoadCases } = require("../lib/results/load-cases");
const { readBeamStations } = require("../lib/results/beam-stations");

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
