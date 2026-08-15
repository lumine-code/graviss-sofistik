const path = require("node:path");

/**
 * Selects the SOFiSTiK release a database is read with.
 *
 * Every part of that answer — the release, the installation folder and the
 * licensed edition — is a property of the installation, so all three come from
 * the sofistik-environment service. This package configures none of them; it
 * only says which database it wants to open.
 */
class SofistikEnvironment {
  constructor(options = {}) {
    this.environmentProvider = options.environmentProvider || null;
  }

  setEnvironmentProvider(provider) {
    this.environmentProvider = provider;
  }

  resolve(databasePath, overrides = {}) {
    if (!this.environmentProvider) {
      throw new Error("The sofistik-environment service is not available.");
    }
    // Absolute before it goes to the service: detection looks for a
    // `sofistik.def` beside the file, which a relative path would hunt for
    // beside the working directory instead.
    const absolutePath = path.resolve(databasePath);
    // An override is the caller's chosen release, so the service resolves the
    // installation for that one rather than the one the database path implies.
    // The edition words are the reader library's own, so an unknown one is
    // refused there, once, naming what it accepts.
    const resolved = this.environmentProvider.resolve({
      filePath: absolutePath,
      version: overrides.version,
      edition: overrides.edition,
    });
    if (!resolved.root) {
      throw new Error('Configure "sofistik-environment.envPath" before opening a CDB.');
    }
    return {
      databasePath: absolutePath,
      version: String(resolved.version),
      edition: resolved.edition,
      environmentRoot: resolved.root,
    };
  }
}

module.exports = { SofistikEnvironment };
