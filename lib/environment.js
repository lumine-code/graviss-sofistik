const path = require("node:path");
const { SofistikContextResolver } = require("@lumine-code/sofistik-context");

/**
 * Selects the SOFiSTiK release a database is read with.
 *
 * The lightweight resolver selects the adjacent definition and installation.
 * The owning view supplies its file path separately from the database path.
 */
class SofistikEnvironment {
  constructor(options = {}) {
    this.resolver = options.resolver || new SofistikContextResolver();
  }

  resolve(databasePath, overrides = {}) {
    // The native reader needs an absolute database path even when a view owns
    // the environment context and references a database in another directory.
    const absolutePath = path.resolve(databasePath);
    // An override is the caller's chosen release, so the library resolves the
    // installation for that one rather than the one the database path implies.
    // The edition words are the reader library's own, so an unknown one is
    // refused there, once, naming what it accepts.
    const resolved = this.resolver.resolve({
      filePath: overrides.filePath ? path.resolve(overrides.filePath) : absolutePath,
      edition: overrides.edition,
      version: overrides.version,
    });
    if (!resolved.version) {
      throw new Error(`No SOFiSTiK release is installed at ${resolved.root}.`);
    }
    if (!resolved.installed) {
      throw new Error(`SOFiSTiK ${resolved.version} is not installed at ${resolved.installPath}.`);
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
