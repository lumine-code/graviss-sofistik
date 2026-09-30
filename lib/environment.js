const path = require("node:path");
const { SofistikEnvironmentResolver } = require("@lumine-code/sofistik-env");

/**
 * Selects the SOFiSTiK release a database is read with.
 *
 * The lightweight resolver selects the root definition and installation.
 * This package supplies the workspace root and requested database path.
 */
class SofistikEnvironment {
  constructor(options = {}) {
    this.resolver = options.resolver || new SofistikEnvironmentResolver();
    this.projectPathForFile =
      options.projectPathForFile ||
      ((filePath) => lumine.project.relativizePath(filePath)[0] || path.dirname(filePath));
  }

  resolve(databasePath, overrides = {}) {
    // Project containment and the fallback directory both require an absolute
    // database path rather than the viewer's relative source spelling.
    const absolutePath = path.resolve(databasePath);
    // An override is the caller's chosen release, so the library resolves the
    // installation for that one rather than the one the database path implies.
    // The edition words are the reader library's own, so an unknown one is
    // refused there, once, naming what it accepts.
    const resolved = this.resolver.resolve({
      projectPath: overrides.projectPath || this.projectPathForFile(absolutePath),
      filePath: absolutePath,
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
