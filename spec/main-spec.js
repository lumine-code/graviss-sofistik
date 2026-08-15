const fs = require("node:fs");
const path = require("node:path");
const { SofistikEnvironment } = require("../lib/environment");
const { SofistikSession } = require("../lib/sofistik-session");

describe("graviss-sofistik package", () => {
  let main;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    const pack = await lumine.packages.activatePackage("graviss-sofistik");
    main = pack.mainModule;
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("graviss-sofistik");
  });

  it("registers no commands of its own", () => {
    const commands = lumine.commands
      .findCommands({ target: lumine.workspace.getElement() })
      .map(({ name }) => name);
    expect(commands.filter((name) => name.startsWith("graviss-sofistik:"))).toEqual([]);
  });

  it("unwraps the sofistik-tools environment service", () => {
    const provider = { resolve() {} };
    const consumption = main.consumeSofistikEnvironment({
      name: "sofistik-environment",
      version: "1.0.0",
      provider,
    });
    expect(main.environment.environmentProvider).toBe(provider);
    consumption.dispose();
    expect(main.environment.environmentProvider).toBeNull();
  });

  it("provides a graviss.source provider that resolves CDB databases", () => {
    const provider = main.provideGravissSource();
    expect(provider).toBe(main.sourceProvider);
    expect(provider.id).toBe("graviss-sofistik");
    // Graviss opens .grv documents only; a provider registers no extension.
    expect(provider.openableExtensions).toBeUndefined();

    const viewPath = path.resolve("model.grv");
    const session = provider.createSession({
      filePath: viewPath,
      viewDocument: { getData: () => ({ title: "Model", source: "model.cdb" }) },
    });
    expect(session.databasePath).toBe(path.resolve("model.cdb"));
    expect(
      provider.createSession({
        filePath: viewPath,
        viewDocument: { getData: () => ({ title: "Model", source: "model.inp" }) },
      }),
    ).toBeNull();
  });

  it("reads the development CDB through the installed 2026 interface", async () => {
    const environmentRoot = "C:\\Program Files\\SOFiSTiK";
    const dllPath = path.join(
      environmentRoot,
      "2026",
      "SOFiSTiK 2026",
      "interfaces",
      "64bit",
      "sof_cdb_w_edu-2026.dll",
    );
    if (process.platform !== "win32" || !fs.existsSync(dllPath)) {
      pending("SOFiSTiK 2026 Educational is not installed");
      return;
    }
    const environment = new SofistikEnvironment({
      environmentProvider: {
        resolve: () => ({
          version: "2026",
          edition: "educational",
          root: environmentRoot,
          installPath: path.join(environmentRoot, "2026", "SOFiSTiK 2026"),
          installed: true,
        }),
      },
    });
    const databasePath = path.resolve(__dirname, "..", ".dev", "main-1.cdb");
    if (!fs.existsSync(databasePath)) {
      pending("The development CDB sample is not present");
      return;
    }
    const session = new SofistikSession(databasePath, { environment });
    try {
      const description = await session.describe();
      expect(description.capabilities.geometry).toEqual(
        jasmine.objectContaining({ sections: true, localAxes: true }),
      );
      expect(Object.keys(description.capabilities)).toEqual(["geometry"]);
      expect(description.model.coordinateSystem).toEqual({
        upAxis: "-z",
        handedness: "right",
        gravityAxis: "+z",
      });
      const geometry = await session.getGeometry();
      expect(geometry.nodes.length).toBe(6583);
      expect(geometry.elements.filter(({ kind }) => kind === "beam").length).toBe(1744);
      expect(geometry.elements.filter(({ kind }) => kind === "shell").length).toBe(6420);
      expect(geometry.supports.length).toBe(0);
      expect(geometry.sections.length).toBe(6);
      expect(geometry.sections.every(({ shape }) => shape?.kind === "polygon")).toBe(true);
      expect(geometry.sections.every(({ shape }) => shape.points.length >= 4)).toBe(true);
      const beams = geometry.elements.filter(({ kind }) => kind === "beam");
      expect(beams.every(({ sectionId }) => sectionId != null)).toBe(true);
      expect(new Set(beams.map(({ sectionId }) => sectionId)).size).toBe(6);
      expect(geometry.elements.some(({ localAxes }) => localAxes)).toBe(true);
      expect(geometry.nodes.find(({ id }) => id === 1)).toEqual(
        jasmine.objectContaining({
          x: 0.17000000178813934,
          y: -1.649999976158142,
          z: 0.029999999329447746,
        }),
      );
    } finally {
      await session.dispose();
    }
  }, 30000);
});
