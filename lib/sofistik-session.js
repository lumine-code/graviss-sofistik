const path = require("node:path");
const { coordinateSystemMetadata } = require("./coordinate-system");
const sessionRuntime = require("./session-runtime-loader");

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
      (async (filePath, databaseOptions) => {
        const { CdbDatabase } = await this.getRuntime();
        this.ensureActive();
        return new CdbDatabase(filePath, databaseOptions);
      });
    this.databasePromise = options.database ? Promise.resolve(options.database) : null;
    this.disposed = false;
    this.described = false;
    this.resolvedEnvironmentPromise = null;
    this.systemInfoPromise = null;
    this.geometryPromise = null;
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

  async getRuntime() {
    this.ensureActive();
    const runtime = await sessionRuntime.load();
    this.ensureActive();
    return runtime;
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
    if (!this.databasePromise) {
      const pending = this.resolveEnvironment()
        .then((resolved) => {
          this.ensureActive();
          return this.databaseFactory(this.databasePath, {
            version: resolved.version,
            edition: resolved.edition,
            environmentRoot: resolved.environmentRoot,
          });
        })
        .catch((error) => {
          if (this.databasePromise === pending) this.databasePromise = null;
          throw error;
        });
      this.databasePromise = pending;
    }
    return this.databasePromise;
  }

  // System record 10/0: the problem type, the signed gravity axis the model was
  // built with, and the divisor an element's group is derived from - all in the
  // one record, so the group costs no read of its own.
  async getSystemInfo() {
    this.ensureActive();
    if (!this.systemInfoPromise) {
      const pending = this.getDatabase()
        .then(async (database) => {
          this.ensureActive();
          const system = await database.read("system", undefined, {
            decodePolicy: "variable-tail",
          });
          if (!system.count) throw new Error("The CDB holds no system record.");
          return {
            problemType: system.columns.iprob[0],
            gravityAxis: system.columns.iachs[0],
            groupDivisor: system.columns.igdiv?.[0] ?? 0,
          };
        })
        .catch((error) => {
          if (this.systemInfoPromise === pending) this.systemInfoPromise = null;
          throw error;
        });
      this.systemInfoPromise = pending;
    }
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
        results: { displacement: true, loadCases: true, beamStations: true, memberDiagram: true },
        filterTypes: true,
      },
    };
  }

  async getLoadCases() {
    this.ensureDescribed();
    this.loadCasesPromise ||= this.getDatabase()
      .then(async (database) => {
        const { readLoadCases } = await this.getRuntime();
        this.ensureActive();
        return readLoadCases(database);
      })
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

  // A case and result kind share their read until it settles; only the latest
  // result is retained afterwards. A slower, older read still answers its own
  // callers, but cannot replace the case the viewer most recently requested.
  getResult({ loadCaseId, kind = "displacement" } = {}) {
    try {
      this.ensureDescribed();
      if (kind !== "displacement" && kind !== "memberDiagram") {
        throw new RangeError(
          `A SOFiSTiK session reads displacements and member diagrams, not ${kind}.`,
        );
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const request = ++this.resultRequest;
    const key = JSON.stringify([kind, typeof loadCaseId, loadCaseId]);
    if (this.lastResult?.kind === kind && this.lastResult.loadCaseId === loadCaseId) {
      return Promise.resolve(this.lastResult);
    }
    const pending = this.pendingResults.get(key);
    if (pending) {
      pending.request = request;
      return pending.promise;
    }
    const read = { request, promise: null };
    read.promise = this.getDatabase()
      .then(async (database) => {
        const { readActiveGroups, activeElementIds } = await this.getRuntime();
        const field = await this.readResultField(database, loadCaseId, kind);
        this.ensureActive();
        const groups = await readActiveGroups(database, loadCaseId);
        this.ensureActive();
        // Reuse the displayed geometry snapshot. A result requested before
        // getGeometry() still receives a complete, self-contained element mask.
        const geometry = groups ? await (this.geometryPromise || this.getGeometry()) : null;
        this.ensureActive();
        const result = {
          kind,
          loadCaseId,
          ...field,
          ...(groups ? { activeElementIds: activeElementIds(geometry, groups) } : {}),
        };
        if (read.request === this.resultRequest) this.lastResult = result;
        return result;
      })
      .finally(() => {
        if (this.pendingResults.get(key) === read) this.pendingResults.delete(key);
      });
    this.pendingResults.set(key, read);
    return read.promise;
  }

  async readResultField(database, loadCaseId, kind) {
    const { readMemberDiagram, assertPhysicalResultCase, readDisplacements, readBeamStations } =
      await this.getRuntime();
    this.ensureActive();
    const elementIdOf = (number) =>
      Number.isInteger(number) && number > 0 ? `beam-${number}` : null;
    if (kind === "memberDiagram") return readMemberDiagram(database, loadCaseId, elementIdOf);
    await assertPhysicalResultCase(database, loadCaseId);
    this.ensureActive();
    const { ids, values, components, extent } = await readDisplacements(database, loadCaseId);
    this.ensureActive();
    const elements = await readBeamStations(database, loadCaseId, elementIdOf);
    if (!ids.length && !elements.length)
      throw new RangeError("This load case contains no displacement results.");
    return {
      components,
      nodes: { ids, values },
      extent,
      ...(elements.length ? { elements } : {}),
    };
  }

  async getGeometry() {
    this.ensureDescribed();
    const pending = this.readGeometry();
    this.geometryPromise = pending;
    try {
      return await pending;
    } catch (error) {
      if (this.geometryPromise === pending) this.geometryPromise = null;
      throw error;
    }
  }

  async readGeometry() {
    // describe() has already read and held the system record, so the gravity
    // axis a member's default frame is measured against costs nothing here.
    const [database, systemInfo, { buildGeometry }] = await Promise.all([
      this.getDatabase(),
      this.getSystemInfo(),
      this.getRuntime(),
    ]);
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
    this.geometryPromise = null;
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
