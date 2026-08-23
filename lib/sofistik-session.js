const path = require("node:path");
const { CdbDatabase } = require("@lumine-code/sofistik-reader");
const { coordinateSystemMetadata } = require("./coordinate-system");
const { buildGeometry } = require("./model-geometry");

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

  // System record 10/0: the problem type and the signed gravity axis the model
  // was built with.
  async getSystemInfo() {
    this.ensureActive();
    this.systemInfoPromise ||= this.getDatabase().then(async (database) => {
      const system = await database.read("system", undefined, { partial: true });
      if (!system.count) throw new Error("The CDB holds no system record.");
      return { problemType: system.columns.iprob[0], gravityAxis: system.columns.iachs[0] };
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
        coordinateSystem: coordinateSystemMetadata(systemInfo.gravityAxis),
      },
      capabilities: {
        geometry: {
          elementKinds: ["beam", "truss", "cable", "shell", "spring", "coupling"],
          supports: true,
          sections: true,
          localAxes: true,
        },
      },
    };
  }

  async getGeometry() {
    this.ensureDescribed();
    return buildGeometry(await this.getDatabase());
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
    this.disposePromise = databasePromise
      ? databasePromise.then((database) => database.dispose()).catch(() => {})
      : Promise.resolve();
    return this.disposePromise;
  }
}

module.exports = { SofistikSession };
