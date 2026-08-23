const path = require("node:path");
const { CdbDatabase } = require("@lumine-code/sofistik-reader");
const { coordinateSystemMetadata } = require("./coordinate-system");
const { buildGeometry } = require("./model-geometry");
const { readBeamStations, readDisplacements, readLoadCases } = require("./results");

class SofistikSession {
  constructor(databasePath, options = {}) {
    if (path.extname(databasePath).toLowerCase() !== ".cdb") {
      throw new RangeError("SOFiSTiK sessions require a .cdb database.");
    }
    this.providerId = "sofistik-reader";
    this.databasePath = path.resolve(databasePath);
    this.title = options.title || path.basename(databasePath, path.extname(databasePath));
    this.environment = options.environment;
    this.databaseFactory =
      options.databaseFactory ||
      ((filePath, databaseOptions) => new CdbDatabase(filePath, databaseOptions));
    this.databasePromise = options.database ? Promise.resolve(options.database) : null;
    this.disposed = false;
    this.described = false;
    this.resolvedEnvironmentPromise = null;
    this.systemInfoPromise = null;
    this.loadCasesPromise = null;
    // One result held at a time. Animating a case re-reads nothing, and moving
    // to another drops the one before it rather than growing without bound - a
    // field of six thousand nodes is not something to accumulate.
    this.lastResult = null;
    this.disposePromise = null;
  }

  ensureActive() {
    if (this.disposed) throw new Error("The SOFiSTiK CDB session is closed.");
  }

  resolveEnvironment() {
    this.ensureActive();
    if (!this.environment) throw new Error("A SOFiSTiK environment resolver is required.");
    this.resolvedEnvironmentPromise ||= Promise.resolve(
      this.environment.resolve(this.databasePath),
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
      const system = await database.read("system", undefined, { partial: true });
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
        facets: true,
      },
    };
  }

  async getLoadCases() {
    this.ensureDescribed();
    this.loadCasesPromise ||= this.getDatabase().then((database) => readLoadCases(database));
    return this.loadCasesPromise;
  }

  // The displacement field of one load case, in metres and radians. Held until
  // another case is asked for, because animating one re-reads it every frame
  // otherwise and a field of six thousand nodes is not a cheap read.
  async getResult({ loadCaseId, kind = "displacement" } = {}) {
    this.ensureDescribed();
    if (kind !== "displacement") {
      throw new RangeError(`A SOFiSTiK session reads displacements, not ${kind}.`);
    }
    if (this.lastResult?.loadCaseId === loadCaseId) return this.lastResult;
    const database = await this.getDatabase();
    const { ids, values, components, extent } = await readDisplacements(database, loadCaseId);
    const elements = await readBeamStations(database, loadCaseId, (number) =>
      Number.isFinite(number) && number > 0 ? `beam-${number}` : null,
    );
    this.lastResult = {
      kind: "displacement",
      loadCaseId,
      components,
      nodes: { ids, values },
      extent,
      ...(elements.length ? { elements } : {}),
    };
    return this.lastResult;
  }

  async getGeometry() {
    this.ensureDescribed();
    // describe() has already read and held the system record, so the gravity
    // axis a member's default frame is measured against costs nothing here.
    const [database, systemInfo] = await Promise.all([this.getDatabase(), this.getSystemInfo()]);
    return buildGeometry(database, systemInfo.gravityAxis, systemInfo.groupDivisor);
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
    this.disposePromise = databasePromise
      ? databasePromise.then((database) => database.dispose()).catch(() => {})
      : Promise.resolve();
    return this.disposePromise;
  }
}

module.exports = { SofistikSession };
