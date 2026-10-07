const path = require("node:path");
const { CdbDatabase } = require("@lumine-code/sofistik-reader");
const { coordinateSystemMetadata } = require("./coordinate-system");
const { buildGeometry } = require("./model-geometry");
const { readBeamStations } = require("./results/beam-stations");
const { readDisplacements } = require("./results/displacements");
const { readLoadCases } = require("./results/load-cases");

class SofistikSession {
  constructor(databasePath, options = {}) {
    if (path.extname(databasePath).toLowerCase() !== ".cdb") {
      throw new RangeError("SOFiSTiK sessions require a .cdb database.");
    }
    this.providerId = "sofistik-reader";
    this.databasePath = path.resolve(databasePath);
    this.title = options.title || path.basename(databasePath, path.extname(databasePath));
    this.environment = options.environment;
    this.filePath = options.filePath ? path.resolve(options.filePath) : null;
    this.databaseFactory =
      options.databaseFactory ||
      ((filePath, databaseOptions) => new CdbDatabase(filePath, databaseOptions));
    this.databasePromise = options.database ? Promise.resolve(options.database) : null;
    this.disposed = false;
    this.described = false;
    this.resolvedEnvironmentPromise = null;
    this.systemInfoPromise = null;
    this.loadCasesPromise = null;
    // One completed result held at a time: animating a case re-reads nothing,
    // without accumulating fields of thousands of nodes as cases are selected.
    this.lastResult = null;
    this.pendingResults = new Map();
    this.resultRequest = 0;
    this.disposePromise = null;
  }

  ensureActive() {
    if (this.disposed) throw new Error("The SOFiSTiK CDB session is closed.");
  }

  resolveEnvironment() {
    this.ensureActive();
    if (!this.environment) throw new Error("A SOFiSTiK environment resolver is required.");
    this.resolvedEnvironmentPromise ||= Promise.resolve(
      this.filePath
        ? this.environment.resolve(this.databasePath, { filePath: this.filePath })
        : this.environment.resolve(this.databasePath),
    );
    return this.resolvedEnvironmentPromise;
  }

  async getDatabase() {
    this.ensureActive();
    this.databasePromise ||= this.resolveEnvironment().then((resolved) => {
      this.ensureActive();
      return this.databaseFactory(this.databasePath, {
        version: resolved.version,
        edition: resolved.edition,
        environmentRoot: resolved.environmentRoot,
      });
    });
    return this.databasePromise;
  }

  // System record 10/0: the problem type, the signed gravity axis the model was
  // built with, and the divisor an element's group is derived from - all in the
  // one record, so the group costs no read of its own.
  async getSystemInfo() {
    this.ensureActive();
    this.systemInfoPromise ||= this.getDatabase().then(async (database) => {
      const system = await database.read("system", undefined, { decodePolicy: "variable-tail" });
      if (!system.count) throw new Error("The CDB holds no system record.");
      return {
        problemType: system.columns.iprob[0],
        gravityAxis: system.columns.iachs[0],
        groupDivisor: system.columns.igdiv?.[0] ?? 0,
      };
    });
    return this.systemInfoPromise;
  }

  async describe() {
    this.ensureActive();
    const [resolved, systemInfo] = await Promise.all([
      this.resolveEnvironment(),
      this.getSystemInfo(),
    ]);
    this.ensureActive();
    this.described = true;
    return {
      model: {
        id: this.databasePath,
        title: this.title,
        source: `SOFiSTiK ${resolved.version} ${resolved.edition} - ${this.databasePath}`,
        coordinateSystem: coordinateSystemMetadata(systemInfo.gravityAxis, systemInfo.problemType),
      },
      capabilities: {
        geometry: {
          elementKinds: ["beam", "truss", "cable", "shell", "spring", "coupling"],
          supports: true,
          sections: true,
          localAxes: true,
        },
        results: { displacement: true, loadCases: true, beamStations: true },
        filterTypes: true,
      },
    };
  }

  async getLoadCases() {
    this.ensureDescribed();
    this.loadCasesPromise ||= this.getDatabase()
      .then((database) => readLoadCases(database))
      .then((loadCases) => {
        this.ensureActive();
        return loadCases;
      })
      .catch((error) => {
        this.loadCasesPromise = null;
        throw error;
      });
    return this.loadCasesPromise;
  }

  // A case shares its read until it settles; only the last requested successful
  // result is retained afterwards. A slower, older read still answers its own
  // callers, but cannot replace the case the viewer most recently requested.
  getResult({ loadCaseId, kind = "displacement" } = {}) {
    try {
      this.ensureDescribed();
      if (kind !== "displacement") {
        throw new RangeError(`A SOFiSTiK session reads displacements, not ${kind}.`);
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const request = ++this.resultRequest;
    if (this.lastResult?.loadCaseId === loadCaseId) return Promise.resolve(this.lastResult);
    const pending = this.pendingResults.get(loadCaseId);
    if (pending) {
      pending.request = request;
      return pending.promise;
    }
    const read = { request, promise: null };
    read.promise = this.getDatabase()
      .then(async (database) => {
        this.ensureActive();
        const { ids, values, components, extent } = await readDisplacements(database, loadCaseId);
        this.ensureActive();
        const elements = await readBeamStations(database, loadCaseId, (number) =>
          Number.isFinite(number) && number > 0 ? `beam-${number}` : null,
        );
        this.ensureActive();
        const result = {
          kind: "displacement",
          loadCaseId,
          components,
          nodes: { ids, values },
          extent,
          ...(elements.length ? { elements } : {}),
        };
        if (read.request === this.resultRequest) this.lastResult = result;
        return result;
      })
      .finally(() => {
        if (this.pendingResults.get(loadCaseId) === read) this.pendingResults.delete(loadCaseId);
      });
    this.pendingResults.set(loadCaseId, read);
    return read.promise;
  }

  async getGeometry() {
    this.ensureDescribed();
    // describe() has already read and held the system record, so the gravity
    // axis a member's default frame is measured against costs nothing here.
    const [database, systemInfo] = await Promise.all([this.getDatabase(), this.getSystemInfo()]);
    this.ensureActive();
    const geometry = await buildGeometry(database, systemInfo.gravityAxis, systemInfo.groupDivisor);
    this.ensureActive();
    return geometry;
  }

  ensureDescribed() {
    this.ensureActive();
    if (!this.described) throw new Error("SofistikSession.describe() must be called first.");
  }

  dispose() {
    if (this.disposed) return this.disposePromise;
    this.disposed = true;
    const databasePromise = this.databasePromise;
    this.databasePromise = null;
    this.resolvedEnvironmentPromise = null;
    this.systemInfoPromise = null;
    this.loadCasesPromise = null;
    this.lastResult = null;
    this.pendingResults.clear();
    this.disposePromise = databasePromise
      ? databasePromise.then((database) => database.dispose()).catch(() => {})
      : Promise.resolve();
    return this.disposePromise;
  }
}

module.exports = { SofistikSession };
