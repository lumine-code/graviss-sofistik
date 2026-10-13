const { execFileSync } = require("node:child_process");
const path = require("node:path");
const runtimeLoader = require("../lib/session-runtime-loader");
const { SofistikSession } = require("../lib/sofistik-session");

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function environment() {
  return { resolve: () => ({ version: "2026", edition: "educational" }) };
}

describe("Native SOFiSTiK session runtime", () => {
  it("publishes the source provider and creates a session without loading the reader or projections", () => {
    const source = `
      const path = require("node:path");
      const main = require("./lib/main");
      main.activate();
      const session = main.provideGravissSource().createSession({
        viewDocument: { getData: () => ({ source: "model.cdb" }) },
        filePath: path.resolve("model.grv")
      });
      if (!session || typeof session.describe !== "function") throw new Error("Missing session");
      console.log(JSON.stringify(Object.keys(require.cache).filter((filename) => {
        const normalized = filename.replaceAll("\\\\", "/");
        return normalized.endsWith("/lib/session-runtime.js") || normalized.includes("/sofistik-reader/");
      })));
    `;
    const output = execFileSync(process.execPath, ["-e", source], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      encoding: "utf8",
    });
    expect(JSON.parse(output.trim())).toEqual([]);
  });

  it("shares one native import and the existing CommonJS reader identities", async () => {
    const first = runtimeLoader.load();
    expect(runtimeLoader.load()).toBe(first);
    const runtime = await first;
    expect(runtime).toBe(require("../lib/session-runtime"));
    expect(runtime.CdbDatabase).toBe(require("@lumine-code/sofistik-reader").CdbDatabase);
    expect(typeof runtime.buildGeometry).toBe("function");
  });

  it("imports only on the first database request and constructs one database for concurrent callers", async () => {
    const database = { dispose: jasmine.createSpy("dispose") };
    const CdbDatabase = jasmine.createSpy("CdbDatabase").and.returnValue(database);
    const load = spyOn(runtimeLoader, "load").and.resolveTo({ CdbDatabase });
    const session = new SofistikSession("model.cdb", { environment: environment() });
    expect(load).not.toHaveBeenCalled();
    const results = await Promise.all([session.getDatabase(), session.getDatabase()]);
    expect(results).toEqual([database, database]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(CdbDatabase).toHaveBeenCalledTimes(1);
    await session.dispose();
    expect(database.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not construct a database after the session closes while its runtime imports", async () => {
    const runtime = deferred();
    const started = deferred();
    const CdbDatabase = jasmine.createSpy("CdbDatabase");
    spyOn(runtimeLoader, "load").and.callFake(() => {
      started.resolve();
      return runtime.promise;
    });
    const session = new SofistikSession("model.cdb", { environment: environment() });
    const failure = expectAsync(session.getDatabase()).toBeRejectedWithError(/closed/);
    await started.promise;
    const disposed = session.dispose();
    runtime.resolve({ CdbDatabase });
    await Promise.all([failure, disposed]);
    expect(CdbDatabase).not.toHaveBeenCalled();
    expect(session.databasePromise).toBeNull();
  });

  it("allows describe to retry after a runtime import fails", async () => {
    const database = {
      read: jasmine.createSpy("read").and.resolveTo({
        count: 1,
        columns: { iprob: Int32Array.of(0), iachs: Int32Array.of(-3) },
      }),
      dispose: jasmine.createSpy("dispose"),
    };
    const CdbDatabase = jasmine.createSpy("CdbDatabase").and.returnValue(database);
    const load = spyOn(runtimeLoader, "load").and.rejectWith(new Error("Import unavailable"));
    const session = new SofistikSession("model.cdb", { environment: environment() });
    await expectAsync(session.describe()).toBeRejectedWithError("Import unavailable");
    load.and.resolveTo({ CdbDatabase });
    expect((await session.describe()).model.coordinateSystem.upAxis).toBe("z");
    expect(load).toHaveBeenCalledTimes(2);
    expect(CdbDatabase).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  for (const method of ["getLoadCases", "getGeometry", "getResult"]) {
    it(`does not start ${method} projections after closing during the import`, async () => {
      const runtime = deferred();
      const started = deferred();
      spyOn(runtimeLoader, "load").and.callFake(() => {
        started.resolve();
        return runtime.promise;
      });
      const read = jasmine.createSpy("read");
      const session = new SofistikSession("model.cdb", {
        database: { read, dispose() {} },
        environment: environment(),
      });
      session.described = true;
      session.systemInfoPromise = Promise.resolve({ gravityAxis: -3 });
      const failure = expectAsync(session[method]({ loadCaseId: 1 })).toBeRejectedWithError(
        /closed/,
      );
      await started.promise;
      await session.dispose();
      runtime.resolve({});
      await failure;
      expect(read).not.toHaveBeenCalled();
    });
  }
});
