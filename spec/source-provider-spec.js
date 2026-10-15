const path = require("node:path");
const { SofistikSourceProvider } = require("../lib/source-provider");

describe("SOFiSTiK sources for new Graviss views", () => {
  let provider, exists;

  beforeEach(() => {
    exists = jasmine.createSpy("exists").and.returnValue(true);
    provider = new SofistikSourceProvider({
      exists,
      Session: class {
        constructor(databasePath, options) {
          this.databasePath = databasePath;
          this.filePath = options.filePath;
        }
      },
    });
  });

  it("opens an absolute source without a view path or an inferred basename", () => {
    const databasePath = path.resolve("external", "model.cdb");
    const session = provider.createSession({
      filePath: null,
      viewDocument: { getData: () => ({ source: databasePath }) },
    });
    expect(session.databasePath).toBe(databasePath);
    expect(session.filePath).toBeNull();
    expect(exists).not.toHaveBeenCalled();
  });

  it("declines an unsaved view without a source or with a relative reference", () => {
    for (const document of [{}, { source: "model.cdb" }, { source: path.resolve("model.inp") }]) {
      expect(
        provider.createSession({
          filePath: null,
          viewDocument: { getData: () => document },
        }),
      ).toBeNull();
    }
    expect(exists).not.toHaveBeenCalled();
  });
});
