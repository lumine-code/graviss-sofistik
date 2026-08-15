const path = require("node:path");
const { SofistikEnvironment } = require("../lib/environment");

describe("SofistikEnvironment", () => {
  it("takes the version, folder and edition from the environment service", () => {
    const databasePath = path.resolve("model.cdb");
    const root = path.resolve("SOFiSTiK");
    const resolve = jasmine.createSpy("resolve").and.returnValue({
      version: "2026",
      edition: "educational",
      root,
      installPath: path.join(root, "2026", "SOFiSTiK 2026"),
      installed: true,
    });
    const environment = new SofistikEnvironment({ environmentProvider: { resolve } });

    expect(environment.resolve(databasePath)).toEqual({
      databasePath,
      version: "2026",
      edition: "educational",
      environmentRoot: root,
    });
    expect(resolve).toHaveBeenCalledWith({
      filePath: databasePath,
      version: undefined,
      edition: undefined,
    });
  });

  it("reports a missing service and a missing installation folder", () => {
    const environment = new SofistikEnvironment();
    expect(() => environment.resolve("model.cdb")).toThrowError(/sofistik-environment/);

    environment.setEnvironmentProvider({
      resolve: () => ({ version: "2025", root: "", installPath: "", installed: false }),
    });
    expect(() => environment.resolve("model.cdb")).toThrowError(/sofistik-environment\.envPath/);

    environment.setEnvironmentProvider({
      resolve: () => ({
        version: "2025",
        edition: "professional",
        root: "root",
        installPath: "root/x",
        installed: true,
      }),
    });
    expect(environment.resolve("model.cdb")).toEqual(
      jasmine.objectContaining({
        version: "2025",
        edition: "professional",
        environmentRoot: "root",
      }),
    );
  });

  it("passes the resolved edition through for the reader to accept or refuse", () => {
    // The edition words belong to @lumine-code/sofistik-reader, which refuses an
    // unknown one once, naming what it accepts, rather than every caller
    // repeating the list.
    const environment = new SofistikEnvironment({
      environmentProvider: {
        resolve: () => ({ version: "2026", edition: "student", root: "root", installed: true }),
      },
    });
    expect(environment.resolve("model.cdb").edition).toBe("student");
  });

  it("asks the service for an overridden version rather than resolving one itself", () => {
    // The override is the caller's chosen release, so the installation folder
    // must be resolved for that release too — not for the detected one with a
    // different version label pasted on.
    const resolve = jasmine.createSpy("resolve").and.callFake(({ version }) => ({
      version: version || "2026",
      root: "root",
      installPath: `root/${version || "2026"}`,
      installed: true,
    }));
    const environment = new SofistikEnvironment({ environmentProvider: { resolve } });

    expect(environment.resolve("model.cdb", { version: "2022" }).version).toBe("2022");
    expect(resolve).toHaveBeenCalledWith({
      filePath: path.resolve("model.cdb"),
      version: "2022",
      edition: undefined,
    });
  });
});
