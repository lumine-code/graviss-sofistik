const fs = require("node:fs");
const path = require("node:path");
const { SofistikEnvironment } = require("../lib/environment");
const { SofistikSession } = require("../lib/sofistik-session");

// The development databases are read through the installed interface, so both
// have to be there. A machine without either states why it skipped rather than
// failing on something it was never given.
const ENVIRONMENT_ROOT = "C:\\Program Files\\SOFiSTiK";
const DLL_PATH = path.join(
  ENVIRONMENT_ROOT,
  "2026",
  "SOFiSTiK 2026",
  "interfaces",
  "64bit",
  "sof_cdb_w_edu-2026.dll",
);

function developmentEnvironment() {
  return new SofistikEnvironment({
    environmentProvider: {
      resolve: () => ({
        version: "2026",
        edition: "educational",
        root: ENVIRONMENT_ROOT,
        installPath: path.join(ENVIRONMENT_ROOT, "2026", "SOFiSTiK 2026"),
        installed: true,
      }),
    },
  });
}

// A database is opened only where both the interface and the sample are
// present; anywhere else the spec says which one was missing and stops.
function developmentSession(name) {
  if (process.platform !== "win32" || !fs.existsSync(DLL_PATH)) {
    pending("SOFiSTiK 2026 Educational is not installed");
    return null;
  }
  const databasePath = path.resolve(__dirname, "..", ".dev", name);
  if (!fs.existsSync(databasePath)) {
    pending("The development CDB sample is not present");
    return null;
  }
  return new SofistikSession(databasePath, { environment: developmentEnvironment() });
}

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
    const session = developmentSession("main-1.cdb");
    if (!session) return;
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

  it("reads a trussed model whose every section is welded from plates", async () => {
    const session = developmentSession("main-3.cdb");
    if (!session) return;
    try {
      await session.describe();
      const geometry = await session.getGeometry();
      expect(geometry.nodes.length).toBe(3001);
      expect(geometry.elements.filter(({ kind }) => kind === "beam").length).toBe(2922);
      expect(geometry.elements.filter(({ kind }) => kind === "truss").length).toBe(170);

      // Every truss names the section it carries, and every one is given the
      // frame a beam of the same axis would have stored, because the record
      // holds none. 126 of the 170 run level and 44 slope.
      const trusses = geometry.elements.filter(({ kind }) => kind === "truss");
      expect(trusses.every(({ sectionId }) => sectionId > 0)).toBe(true);
      expect(trusses.every(({ localAxes }) => localAxes)).toBe(true);
      // Gravity is the +z axis here, and every local z leans the way it does
      // rather than against it - which is what keeps a double angle from being
      // drawn on its back beside the beams it braces. A level one matches the
      // gravity axis exactly, which is what those beams store.
      expect(trusses.every(({ localAxes }) => localAxes.z[2] > 0)).toBe(true);
      expect(trusses.filter(({ localAxes }) => localAxes.z[2] > 0.999).length).toBe(126);
      const beam = geometry.elements.find(({ kind }) => kind === "beam");
      expect(beam.localAxes.z[2]).toBeCloseTo(1, 6);
      expect(new Set(trusses.map(({ sectionId }) => sectionId))).toEqual(
        new Set([52, 54, 55, 73, 76, 77]),
      );

      // Not one section here is a rectangle, a tube or a polygon: all 21 are
      // thin-walled, and until the plates were read every one of them fell
      // through to the rectangle of equivalent stiffness.
      expect(geometry.sections.length).toBe(21);
      expect(geometry.sections.every(({ shape }) => shape.kind === "plates")).toBe(true);

      // A welded plate girder: a 10 mm web trimmed to the inner face of each
      // 260 x 17 flange, both flanges split at the web, and the web split
      // again where the non-effective boundary crosses it. The plates tile the
      // section, so their areas add up to the area the database stores.
      const girder = geometry.sections.find(({ id }) => id === 71);
      expect(girder.shape.plates.length).toBe(6);
      const spans = (plates) =>
        plates.reduce(
          (total, { from, to, thickness }) =>
            total + Math.hypot(to[0] - from[0], to[1] - from[1]) * thickness,
          0,
        );
      expect(spans(girder.shape.plates)).toBeCloseTo(girder.area, 5);

      // Half this girder does not carry: the lower flange and the web below
      // z = -0.2602, marked non-effective for bending about the section's own
      // y. The shape is still the whole of it and the areas name the part that
      // is drawn but not counted.
      expect(girder.ineffective.length).toBe(3);
      const ineffective = girder.ineffective.reduce(
        (total, { points }) =>
          total +
          Math.abs(
            points.reduce((twice, point, index) => {
              const next = points[(index + 1) % points.length];
              return twice + point[0] * next[1] - next[0] * point[1];
            }, 0),
          ) /
            2,
        0,
      );
      expect(ineffective).toBeCloseTo(0.012, 5);
      // Every one of them lies below the boundary, in the half of the section
      // the rule names.
      expect(girder.ineffective.every(({ points }) => points.every(([, z]) => z >= -0.2602))).toBe(
        true,
      );
      // And a section nothing was taken out of says nothing at all.
      expect(geometry.sections.filter(({ ineffective: areas }) => areas).length).toBe(1);
    } finally {
      await session.dispose();
    }
  }, 30000);
});
