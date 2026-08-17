const path = require("node:path");
const { coordinateSystemMetadata } = require("../lib/coordinate-system");
const { SofistikSession } = require("../lib/sofistik-session");
const { SofistikSourceProvider } = require("../lib/source-provider");

describe("SofistikSession", () => {
  it("maps every CDB gravity direction to the opposite model up axis", () => {
    expect([-1, 1, -2, 2, -3, 3].map(coordinateSystemMetadata)).toEqual([
      { upAxis: "x", handedness: "right", gravityAxis: "-x" },
      { upAxis: "-x", handedness: "right", gravityAxis: "+x" },
      { upAxis: "y", handedness: "right", gravityAxis: "-y" },
      { upAxis: "-y", handedness: "right", gravityAxis: "+y" },
      { upAxis: "z", handedness: "right", gravityAxis: "-z" },
      { upAxis: "-z", handedness: "right", gravityAxis: "+z" },
    ]);
  });

  it("requires describe first and delegates only advertised queries", async () => {
    const calls = [];
    // The reader answers in columns, one typed array per field.
    const reads = {
      system: { count: 1, columns: { iprob: Int32Array.of(0), iachs: Int32Array.of(3) } },
      nodes: {
        count: 0,
        columns: { nr: new Int32Array(0), xyz: new Float32Array(0), kfix: new Int32Array(0) },
      },
      beams: {
        count: 0,
        columns: { nr: new Int32Array(0), node: new Int32Array(0), t: new Float32Array(0) },
      },
      quads: {
        count: 0,
        columns: {
          nr: new Int32Array(0),
          node: new Int32Array(0),
          mat: new Int32Array(0),
          thick: new Float32Array(0),
          t: new Float32Array(0),
        },
      },
      // A section record carries its own properties and its dimensions in a
      // sub-record per shape family. Dimensions are exact in float32 so the
      // decoded section can be compared as written.
      section: {
        count: 1,
        columns: { a: Float32Array.of(0.125), mno: Int32Array.of(1) },
        rectangle: {
          count: 1,
          columns: { h: Float32Array.of(0.5), b: Float32Array.of(0.25), iq: Int32Array.of(0) },
        },
      },
    };
    // Only sections are keyed in this database. Answering every name with the
    // same key would make each caller look like it read something it did not.
    const keys = { section: Int32Array.of(101) };
    const database = {
      async read(name, secondary) {
        calls.push(secondary == null ? name : [name, secondary]);
        return reads[name] || { count: 0, columns: {} };
      },
      async keys(name) {
        calls.push(["keys", name]);
        return keys[name] || new Int32Array(0);
      },
      async dispose() {
        calls.push("dispose");
      },
    };
    const resolved = {
      databasePath: path.resolve("main.cdb"),
      version: "2026",
      edition: "educational",
      environmentRoot: "installed",
    };
    const environment = { resolve: jasmine.createSpy("resolve").and.returnValue(resolved) };
    const session = new SofistikSession("main.cdb", { environment, database });

    await expectAsync(session.getGeometry()).toBeRejectedWithError(/describe.*first/i);
    const description = await session.describe();
    expect(description.capabilities.geometry).toEqual(
      jasmine.objectContaining({ sections: true, localAxes: true }),
    );
    expect(Object.keys(description.capabilities)).toEqual(["geometry"]);
    expect(session.getLoadCases).toBeUndefined();
    expect(session.getResult).toBeUndefined();
    expect(description.model.coordinateSystem).toEqual({
      upAxis: "-z",
      handedness: "right",
      gravityAxis: "+z",
    });
    expect(calls).toEqual(["system"]);

    // A section the model stores is described whether or not a beam references
    // it, and its stored dimensions pass through unchanged.
    expect(await session.getGeometry()).toEqual({
      nodes: [],
      elements: [],
      supports: [],
      sections: [
        {
          id: 101,
          name: "Section 101",
          shape: { kind: "rectangle", width: 0.25, height: 0.5 },
          area: 0.125,
          materialId: 1,
        },
      ],
    });
    // Geometry is five reads, the section keys, and one read per section.
    // Nothing else is asked of the database.
    expect(calls).toEqual([
      "system",
      "nodes",
      "beams",
      "quads",
      "springs",
      ["keys", "section"],
      ["section", 101],
    ]);

    await session.dispose();
    expect(calls.at(-1)).toBe("dispose");
  });

  it("creates one library database from the resolved SOFiSTiK environment", async () => {
    const database = {
      read: async (name) =>
        name === "system"
          ? { count: 1, columns: { iprob: Int32Array.of(0), iachs: Int32Array.of(-3) } }
          : {
              count: 0,
              columns: {
                nr: new Int32Array(0),
                xyz: new Float32Array(0),
                kfix: new Int32Array(0),
                node: new Int32Array(0),
                t: new Float32Array(0),
                mat: new Int32Array(0),
                thick: new Float32Array(0),
              },
            },
      keys: async () => new Int32Array(0),
      dispose: jasmine.createSpy("dispose"),
    };
    const databaseFactory = jasmine.createSpy("databaseFactory").and.returnValue(database);
    const resolved = {
      version: "2026",
      edition: "educational",
      environmentRoot: path.resolve("installed"),
    };
    const environment = { resolve: () => resolved };
    const session = new SofistikSession("main.cdb", { environment, databaseFactory });

    await session.describe();
    await session.getGeometry();
    expect(databaseFactory).toHaveBeenCalledTimes(1);
    expect(databaseFactory).toHaveBeenCalledWith(path.resolve("main.cdb"), {
      version: resolved.version,
      edition: resolved.edition,
      environmentRoot: resolved.environmentRoot,
    });
    await session.dispose();
    expect(database.dispose).toHaveBeenCalled();
  });
});

describe("SofistikSourceProvider", () => {
  it("resolves explicit and same-basename CDB sources", () => {
    const sessions = [];
    class Session {
      constructor(filePath, options) {
        sessions.push({ filePath, options });
      }
    }
    const environment = {};
    const provider = new SofistikSourceProvider({
      exists: (filePath) => path.basename(filePath) === "main.cdb",
      Session,
      environment,
    });
    const viewPath = path.resolve("views", "main.grv");
    const implicit = provider.createSession({
      filePath: viewPath,
      viewDocument: { getData: () => ({ title: "Main" }) },
    });
    expect(implicit instanceof Session).toBe(true);
    expect(sessions[0]).toEqual({
      filePath: path.resolve("views", "main.cdb"),
      options: { title: "Main", environment },
    });

    const explicit = provider.resolveSource({ source: "../data/model.cdb" }, viewPath);
    expect(explicit).toBe(path.resolve("data", "model.cdb"));
    expect(provider.resolveSource({ source: "model.inp" }, viewPath)).toBeNull();
  });
});
