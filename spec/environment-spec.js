const path = require("node:path");
const { SofistikEnvironment } = require("../lib/environment");

describe("SofistikEnvironment", () => {
  function resolved(version = "2026", edition = "professional", installed = true) {
    return { version, edition, installed, root: "root", installPath: `root/${version}` };
  }

  it("takes the year, installation and edition from the shared library resolver", () => {
    const databasePath = path.resolve("model.cdb");
    const projectPath = path.resolve("project");
    const resolve = jasmine.createSpy("resolve").and.returnValue(resolved("2026", "educational"));
    const environment = new SofistikEnvironment({
      resolver: { resolve },
      projectPathForFile: () => projectPath,
    });
    expect(environment.resolve(databasePath)).toEqual({
      databasePath,
      version: "2026",
      edition: "educational",
      environmentRoot: "root",
    });
    expect(resolve).toHaveBeenCalledWith({
      projectPath,
      filePath: databasePath,
      version: undefined,
      edition: undefined,
    });
  });

  it("uses the workspace root and the adjacent directory outside it", () => {
    const root = path.resolve("project");
    const inner = path.join(root, "inner");
    const containing = spyOn(lumine.project, "relativizePath").and.callFake((filePath) =>
      filePath.startsWith(inner + path.sep)
        ? [inner, path.relative(inner, filePath)]
        : [null, filePath],
    );
    const resolve = jasmine.createSpy("resolve").and.returnValue(resolved());
    const environment = new SofistikEnvironment({ resolver: { resolve } });
    environment.resolve(path.join(inner, "model.cdb"));
    expect(resolve.calls.mostRecent().args[0].projectPath).toBe(inner);
    const outside = path.resolve("elsewhere", "model.cdb");
    environment.resolve(outside);
    expect(resolve.calls.mostRecent().args[0].projectPath).toBe(path.dirname(outside));
    expect(containing).toHaveBeenCalledWith(outside);
  });

  it("names the selected year when its installation is missing instead of substituting another", () => {
    const environment = new SofistikEnvironment({
      resolver: { resolve: () => resolved("2024", "professional", false) },
    });
    expect(() => environment.resolve("model.cdb")).toThrowError(
      /SOFiSTiK 2024 is not installed at root\/2024/,
    );
  });

  it("reports an unresolved native environment without inventing a release year", () => {
    const environment = new SofistikEnvironment({
      resolver: { resolve: () => ({ version: null, root: "installation-root", installed: false }) },
    });
    expect(() => environment.resolve("model.cdb")).toThrowError(
      "No SOFiSTiK release is installed at installation-root.",
    );
  });

  it("passes the edition through for the reader to accept or refuse", () => {
    const environment = new SofistikEnvironment({
      resolver: { resolve: () => resolved("2026", "student") },
    });
    expect(environment.resolve("model.cdb").edition).toBe("student");
  });

  it("passes explicit source-year overrides to the same resolver", () => {
    const resolve = jasmine.createSpy("resolve").and.callFake(({ version }) => resolved(version));
    const environment = new SofistikEnvironment({ resolver: { resolve } });
    expect(
      environment.resolve("model.cdb", { version: "2022", edition: "educational" }).version,
    ).toBe("2022");
    expect(resolve.calls.mostRecent().args[0]).toEqual({
      projectPath: path.dirname(path.resolve("model.cdb")),
      version: "2022",
      edition: "educational",
      filePath: path.resolve("model.cdb"),
    });
  });
});
