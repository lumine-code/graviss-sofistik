const { readLoadCases } = require("../lib/results/load-cases");

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
