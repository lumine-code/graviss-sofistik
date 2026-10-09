const path = require("node:path");
const { coordinateSystemMetadata, problemTypeOf } = require("../lib/coordinate-system");
const { SofistikSession } = require("../lib/sofistik-session");
const { SofistikSourceProvider } = require("../lib/source-provider");

describe("SofistikSession", () => {
  it("maps every CDB gravity direction to the opposite model up axis", () => {
    expect([-1, 1, -2, 2, -3, 3].map((axis) => coordinateSystemMetadata(axis))).toEqual([
      { upAxis: "x", handedness: "right", gravityAxis: "-x" },
      { upAxis: "-x", handedness: "right", gravityAxis: "+x" },
      { upAxis: "y", handedness: "right", gravityAxis: "-y" },
      { upAxis: "-y", handedness: "right", gravityAxis: "+y" },
      { upAxis: "z", handedness: "right", gravityAxis: "-z" },
      { upAxis: "-z", handedness: "right", gravityAxis: "+z" },
    ]);
  });

  it("falls back to the convention the system type names when gravity is undefined", () => {
    // Zero is a legal IACHS and means the database says nothing. SOFiSTiK's own
    // convention is z downwards, so that is the answer for every system but the
    // ones written in the international x-y coordinate system.
    expect(coordinateSystemMetadata(0, 0)).toEqual({
      upAxis: "-z",
      handedness: "right",
      gravityAxis: "undefined",
    });
    expect(coordinateSystemMetadata(0, 10).upAxis).toBe("-z");
    expect(coordinateSystemMetadata(0, 30).upAxis).toBe("-z");
    // A WCS plane frame puts y up; its slab twin keeps z, because a slab lies
    // in the x-y plane and is drawn seen from above.
    expect(coordinateSystemMetadata(0, 14).upAxis).toBe("y");
    expect(coordinateSystemMetadata(0, 17).upAxis).toBe("y");
    expect(coordinateSystemMetadata(0, 34).upAxis).toBe("z");
    // A database SOFiSTiK found something wrong with negates its problem type
    // with a reason multiplied in, and it is still the system it says it is.
    expect(coordinateSystemMetadata(0, -(14 + 1000 * 3)).upAxis).toBe("y");
    expect(problemTypeOf(-(30 + 1000 * 7))).toBe(30);
    expect(problemTypeOf(undefined)).toBeNull();
    // A stated gravity axis settles it and the system type is never consulted.
    expect(coordinateSystemMetadata(3, 14).upAxis).toBe("-z");
    expect(coordinateSystemMetadata(-3, 10).upAxis).toBe("z");
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
    // A CDB holds what was solved for it and the dimensions a model is divided
    // along, so the session answers for both beside the geometry.
    expect(Object.keys(description.capabilities)).toEqual(["geometry", "results", "filterTypes"]);
    expect(description.capabilities.results).toEqual({
      displacement: true,
      loadCases: true,
      beamStations: true,
    });
    expect(description.capabilities.filterTypes).toBe(true);
    expect(typeof session.getLoadCases).toBe("function");
    expect(typeof session.getResult).toBe("function");
    await expectAsync(session.getResult({ loadCaseId: 1, kind: "force" })).toBeRejectedWithError(
      /reads displacements/,
    );
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
    // Geometry is eight reads, the section keys, and one read per section.
    // Nothing else is asked of the database.
    expect(calls).toEqual([
      "system",
      "nodes",
      "beams",
      "trusses",
      "cables",
      "quads",
      "springs",
      "couplings",
      ["keys", "section"],
      ["section", 101],
      // Groups are read for their names; which elements are in one is
      // arithmetic on the element number and costs no read.
      "groups",
      // Secondary groups are asked for by key first, so a model without any -
      // the ordinary case - costs one key listing and no reads.
      ["keys", "secondaryGroups"],
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

  describe("result requests", () => {
    let session, database, nodeReads, beamReads;

    function deferredRead() {
      let resolve, reject, started;
      const promise = new Promise((accept, fail) => {
        resolve = accept;
        reject = fail;
      });
      const startedPromise = new Promise((accept) => {
        started = accept;
      });
      return { promise, resolve, reject, started, startedPromise };
    }

    function nodes(loadCaseId) {
      return {
        count: 1,
        columns: { nr: Int32Array.of(1), ux: Float32Array.of(loadCaseId) },
      };
    }

    function countReads(name, loadCaseId) {
      return database.read.calls
        .allArgs()
        .filter(([record, number]) => record === name && number === loadCaseId).length;
    }

    beforeEach(async () => {
      nodeReads = new Map();
      beamReads = new Map();
      database = {
        read: jasmine.createSpy("read").and.callFake((name, loadCaseId) => {
          if (name === "system") {
            return { count: 1, columns: { iprob: Int32Array.of(0), iachs: Int32Array.of(-3) } };
          }
          const controlled = (name === "nodeResults" ? nodeReads : beamReads).get(loadCaseId);
          if (controlled) {
            controlled.started();
            return controlled.promise;
          }
          return name === "nodeResults" ? nodes(loadCaseId) : { count: 0, columns: {} };
        }),
        dispose: jasmine.createSpy("dispose"),
      };
      session = new SofistikSession("main.cdb", {
        environment: { resolve: () => ({ version: "2026", edition: "educational" }) },
        database,
      });
      await session.describe();
    });

    afterEach(async () => {
      await session.dispose();
    });

    it("shares one Promise through both stages of a case and caches the completed result", async () => {
      const nodeRead = deferredRead();
      const beamRead = deferredRead();
      nodeReads.set(1, nodeRead);
      beamReads.set(1, beamRead);
      const first = session.getResult({ loadCaseId: 1 });
      expect(session.getResult({ loadCaseId: 1 })).toBe(first);
      await nodeRead.startedPromise;
      expect(countReads("nodeResults", 1)).toBe(1);
      nodeRead.resolve(nodes(1));
      await beamRead.startedPromise;
      expect(session.getResult({ loadCaseId: 1 })).toBe(first);
      beamRead.resolve({
        count: 1,
        columns: {
          nr: Int32Array.of(12),
          x: Float32Array.of(0.5),
          ux: Float32Array.of(0),
          uy: Float32Array.of(0),
          uz: Float32Array.of(0),
          phix: Float32Array.of(0),
          phiy: Float32Array.of(0),
          phiz: Float32Array.of(0),
          phiw: Float32Array.of(0),
        },
      });
      const result = await first;
      expect(result.elements[0].id).toBe("beam-12");
      expect(await session.getResult({ loadCaseId: 1 })).toBe(result);
      expect(countReads("nodeResults", 1)).toBe(1);
      expect(countReads("beamForces", 1)).toBe(1);
      expect(session.pendingResults.size).toBe(0);
    });

    it("keeps the latest requested case when an earlier read finishes last", async () => {
      const earlier = deferredRead();
      const later = deferredRead();
      nodeReads.set(1, earlier);
      nodeReads.set(2, later);
      const first = session.getResult({ loadCaseId: 1 });
      const second = session.getResult({ loadCaseId: 2 });
      await Promise.all([earlier.startedPromise, later.startedPromise]);
      later.resolve(nodes(2));
      const latest = await second;
      earlier.resolve(nodes(1));
      expect((await first).loadCaseId).toBe(1);
      expect(session.lastResult).toBe(latest);
      expect(await session.getResult({ loadCaseId: 2 })).toBe(latest);
      expect(countReads("nodeResults", 2)).toBe(1);
    });

    it("makes a repeated pending case the latest request without duplicating its read", async () => {
      const earlier = deferredRead();
      const later = deferredRead();
      nodeReads.set(1, earlier);
      nodeReads.set(2, later);
      const first = session.getResult({ loadCaseId: 1 });
      const second = session.getResult({ loadCaseId: 2 });
      expect(session.getResult({ loadCaseId: 1 })).toBe(first);
      earlier.resolve(nodes(1));
      const latest = await first;
      later.resolve(nodes(2));
      await second;
      expect(session.lastResult).toBe(latest);
      expect(countReads("nodeResults", 1)).toBe(1);
    });

    it("respects a cached case selected again while another case is reading", async () => {
      const cached = await session.getResult({ loadCaseId: 1 });
      const later = deferredRead();
      nodeReads.set(2, later);
      const second = session.getResult({ loadCaseId: 2 });
      expect(await session.getResult({ loadCaseId: 1 })).toBe(cached);
      later.resolve(nodes(2));
      await second;
      expect(session.lastResult).toBe(cached);
    });

    for (const [name, reads] of [
      ["nodeResults", () => nodeReads],
      ["beamForces", () => beamReads],
    ]) {
      it(`retries a rejected ${name} read and keeps only the last successful result`, async () => {
        const cached = await session.getResult({ loadCaseId: 1 });
        const failed = deferredRead();
        reads().set(2, failed);
        const first = session.getResult({ loadCaseId: 2 });
        const duplicate = session.getResult({ loadCaseId: 2 });
        expect(duplicate).toBe(first);
        const rejection = expectAsync(first).toBeRejectedWithError("CDB read failed");
        await failed.startedPromise;
        failed.reject(new Error("CDB read failed"));
        await rejection;
        expect(session.lastResult).toBe(cached);
        expect(session.pendingResults.size).toBe(0);
        reads().delete(2);
        const retried = await session.getResult({ loadCaseId: 2 });
        expect(session.lastResult).toBe(retried);
        expect(countReads(name, 2)).toBe(2);
        await session.getResult({ loadCaseId: 1 });
        expect(countReads("nodeResults", 1)).toBe(2);
      });

      it(`does not retain a ${name} read completed after disposal`, async () => {
        await session.getResult({ loadCaseId: 1 });
        const pending = deferredRead();
        reads().set(2, pending);
        const result = session.getResult({ loadCaseId: 2 });
        const rejection = expectAsync(result).toBeRejectedWithError(/session is closed/);
        await pending.startedPromise;
        await session.dispose();
        pending.resolve(name === "nodeResults" ? nodes(2) : { count: 0, columns: {} });
        await rejection;
        expect(session.lastResult).toBeNull();
        expect(session.pendingResults.size).toBe(0);
        if (name === "nodeResults") expect(countReads("beamForces", 2)).toBe(0);
        await expectAsync(session.getResult({ loadCaseId: 2 })).toBeRejectedWithError(
          /session is closed/,
        );
        expect(database.dispose).toHaveBeenCalledTimes(1);
      });
    }
  });

  it("shares a pending load-case index, retries a rejected read and caches only the successful index", async () => {
    let rejectIndex, started;
    const pending = new Promise((resolve, reject) => {
      rejectIndex = reject;
    });
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    let indexReads = 0;
    const database = {
      read: jasmine
        .createSpy("read")
        .and.callFake((name) =>
          name === "system"
            ? { count: 1, columns: { iprob: Int32Array.of(0), iachs: Int32Array.of(-3) } }
            : { count: 1, columns: { kind: Int32Array.of(0), rtex: ["Case 101"] } },
        ),
      keys: jasmine.createSpy("keys").and.callFake((name) => {
        if (name === "loadCase" && ++indexReads === 1) {
          started();
          return pending;
        }
        return Int32Array.of(101);
      }),
      dispose: jasmine.createSpy("dispose"),
    };
    const session = new SofistikSession("main.cdb", {
      database,
      environment: { resolve: () => ({ version: "2026", edition: "educational" }) },
    });
    try {
      await session.describe();
      const first = session.getLoadCases();
      const same = session.getLoadCases();
      const rejected = expectAsync(Promise.all([first, same])).toBeRejectedWithError(
        "temporary index failure",
      );
      await entered;
      expect(indexReads).toBe(1);
      rejectIndex(new Error("temporary index failure"));
      await rejected;
      expect(session.loadCasesPromise).toBeNull();
      const retried = await session.getLoadCases();
      expect(retried).toEqual([{ id: 101, title: "Case 101", kind: "linear", hasResults: true }]);
      expect(await session.getLoadCases()).toBe(retried);
      expect(indexReads).toBe(2);
      expect(database.keys.calls.allArgs()).toEqual([["loadCase"], ["loadCase"], ["nodeResults"]]);
    } finally {
      await session.dispose();
    }
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
      options: { title: "Main", environment, filePath: viewPath },
    });

    const explicit = provider.resolveSource({ source: "../data/model.cdb" }, viewPath);
    expect(explicit).toBe(path.resolve("data", "model.cdb"));
    expect(provider.resolveSource({ source: "model.inp" }, viewPath)).toBeNull();
  });
});

describe("session disposal during description", () => {
  it("does not complete description after its native session is disposed", async () => {
    let resolveSystem, started;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    const database = {
      read: () => {
        started();
        return new Promise((resolve) => {
          resolveSystem = resolve;
        });
      },
      dispose: jasmine.createSpy("dispose"),
    };
    const session = new SofistikSession("model.cdb", {
      database,
      environment: { resolve: () => ({ version: "2026", edition: "professional" }) },
    });
    const describe = session.describe();
    await entered;
    await session.dispose();
    resolveSystem({ count: 1, columns: { iprob: Int32Array.of(0), iachs: Int32Array.of(3) } });
    await expectAsync(describe).toBeRejectedWithError(/session is closed/);
    expect(session.described).toBe(false);
  });
});
