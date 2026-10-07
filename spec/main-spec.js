const fs = require("node:fs");
const path = require("node:path");

// The development databases are read through the installed interface. They are
// local integration fixtures rather than package assets, so register each test
// only when its own database and the matching interface are present.
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
  const { SofistikEnvironment } = require("../lib/environment");
  return new SofistikEnvironment({
    resolver: {
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

function developmentSession(name) {
  const { SofistikSession } = require("../lib/sofistik-session");
  const databasePath = path.resolve(__dirname, "..", ".dev", name);
  return new SofistikSession(databasePath, { environment: developmentEnvironment() });
}

function developmentIt(description, databaseName, body) {
  const databasePath = path.resolve(__dirname, "..", ".dev", databaseName);
  if (process.platform === "win32" && fs.existsSync(DLL_PATH) && fs.existsSync(databasePath)) {
    it(description, body, 30000);
  }
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

  it("owns its resolver independently of an environment service", () => {
    expect(typeof main.environment.resolver.resolve).toBe("function");
    expect(main.consumeSofistikEnvironment).toBeUndefined();
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

  it("replaces its service edge when the source package reactivates", async () => {
    const hubPackage = await lumine.packages.activatePackage("graviss");
    const hub = hubPackage.mainModule;
    try {
      const previous = main.provideGravissSource();
      await conditionPromise(() => hub.sourceProviders.includes(previous));
      await lumine.packages.deactivatePackage("graviss-sofistik");
      expect(hub.sourceProviders.includes(previous)).toBe(false);
      const current = await lumine.packages.activatePackage("graviss-sofistik");
      main = current.mainModule;
      const replacement = main.provideGravissSource();
      expect(replacement).not.toBe(previous);
      await conditionPromise(() => hub.sourceProviders.includes(replacement));
      expect(hub.sourceProviders.filter(({ id }) => id === "graviss-sofistik")).toEqual([
        replacement,
      ]);
    } finally {
      await lumine.packages.deactivatePackage("graviss");
    }
  });

  developmentIt(
    "reads the development CDB through the installed 2026 interface",
    "main-1.cdb",
    async () => {
      const session = developmentSession("main-1.cdb");
      try {
        const description = await session.describe();
        expect(description.capabilities.geometry).toEqual(
          jasmine.objectContaining({ sections: true, localAxes: true }),
        );
        expect(Object.keys(description.capabilities)).toEqual([
          "geometry",
          "results",
          "filterTypes",
        ]);
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
    },
  );

  developmentIt(
    "reads PP from the native calculated shell list without selecting overlapping beams",
    "main-1.cdb",
    async () => {
      const { SofistikSession: CurrentSession } = require("../lib/sofistik-session");
      const { SofistikEnvironment: CurrentEnvironment } = require("../lib/environment");
      const environment = new CurrentEnvironment();
      const session = new CurrentSession(path.resolve(__dirname, "../.dev/main-1.cdb"), {
        environment: {
          resolve: (filePath) =>
            environment.resolve(filePath, {
              version: "2026",
              edition: "educational",
            }),
        },
      });
      try {
        await session.describe();
        const database = await session.getDatabase();
        const raw = await database.read("secondaryGroups", 0x20205050, {
          decodePolicy: "variable-tail",
        });
        expect(Array.from(raw.list.columns.id)).toEqual([200]);
        expect(Array.from(raw.list.columns.nr)).toEqual([210001, -213486]);
        const geometry = await session.getGeometry();
        // SDK SGRP_LIS_ID_QUAD=200 scopes the calculated range to QUADs. The
        // native model deliberately has BEAMs with the same element numbers.
        const from = raw.list.columns.nr[0];
        const to = -raw.list.columns.nr[1];
        const inRange = (element) => element.number >= from && element.number <= to;
        const expected = geometry.elements.filter(
          (element) => element.kind === "shell" && inRange(element),
        );
        const actual = geometry.elements.filter((element) =>
          element.filterValues?.secondaryGroup?.includes("PP"),
        );
        expect(expected.length).toBe(3486);
        expect(geometry.elements.filter(inRange).length).toBe(4006);
        expect(
          geometry.elements.filter((element) => element.kind === "beam" && inRange(element)).length,
        ).toBe(520);
        expect(actual.map(({ id }) => id)).toEqual(expected.map(({ id }) => id));
        expect(geometry.filterTypes.find(({ id }) => id === "secondaryGroup")).toEqual(
          jasmine.objectContaining({
            quickFilterCode: "SG",
            multiple: true,
            kinds: ["shell"],
            values: [{ id: "PP" }],
          }),
        );
      } finally {
        await session.dispose();
      }
    },
  );

  developmentIt("reads what the development CDB was solved for, in SI", "main-1.cdb", async () => {
    const session = developmentSession("main-1.cdb");
    try {
      await session.describe();
      const geometry = await session.getGeometry();

      // Every element but a coupling carries the number it was written with,
      // and the group it belongs to is that number divided by the divisor the
      // system record states — 10000 in this model, so a beam numbered 110001
      // is in group 11.
      const group = geometry.filterTypes.find(({ id }) => id === "group");
      expect(group.title).toBe("Group");
      // The groups in this model are unnamed, so a numeric dimension declares
      // no value list at all - a range says what it means without one.
      expect(group.numeric).toBe(true);
      expect(group.kinds.length).toBeGreaterThan(1);
      const beam = geometry.elements.find(({ id }) => id === "beam-110001");
      expect(beam.number).toBe(110001);
      expect(beam.filterValues.group).toBe(11);
      // A coupling has no element number of its own, so it is in no group.
      const coupling = geometry.elements.find(({ kind }) => kind === "coupling");
      expect(coupling?.number).toBeUndefined();
      expect(coupling?.filterValues?.group).toBeUndefined();

      const loadCases = await session.getLoadCases();
      expect(loadCases.length).toBeGreaterThan(3);
      expect(loadCases.every(({ hasResults }) => hasResults === true)).toBe(true);
      const selfWeight = loadCases.find(({ id }) => id === 101);
      expect(selfWeight).toEqual(
        jasmine.objectContaining({ title: "self-weight", kind: "linear", actionType: "G_1" }),
      );
      // A named load definition that was never solved is not a result choice.
      expect(loadCases.find(({ id }) => id === 321)).toBeUndefined();
      // Natural frequencies are stored as the eigenmode variant of LC_CTRL,
      // not as an ordinary load-case record. They carry nodal results and keep
      // the frequency title SOFiSTiK wrote.
      const eigenmode = loadCases.find(({ id }) => id === 10101);
      expect(eigenmode).toEqual(
        jasmine.objectContaining({
          kind: "eigenmode",
          title: jasmine.stringMatching(/13\.13 Hz/),
          hasResults: true,
        }),
      );
      // A buckling mode has no sign, which is the one classification a viewer
      // acts on: it animates such a shape about zero rather than up from it.
      expect(loadCases.find(({ id }) => id === 10201).kind).toBe("buckling");

      const result = await session.getResult({ loadCaseId: 101 });
      expect(result.kind).toBe("displacement");
      expect(result.components).toBe(7);
      expect(result.nodes.ids.length).toBe(geometry.nodes.length);
      expect(result.nodes.values.length).toBe(geometry.nodes.length * 7);

      // The unit check, and it is physical rather than arithmetic. This is a
      // bridge under its own weight: it deflects in millimetres. A factor wrong
      // by a thousand passes every checksum and fails here.
      expect(result.extent).toBeGreaterThan(0.00001);
      expect(result.extent).toBeLessThan(0.5);
      expect(result.extent * 1000).toBeCloseTo(0.33, 1);

      // A member bends between its ends, and the stations say how.
      const stations = result.elements.find(({ id }) => id === "beam-110001").stations;
      expect(stations.length).toBe(2);
      expect(stations[0].x).toBe(0);
      expect(stations[1].x).toBeCloseTo(0.085, 5);
      expect(
        stations.every(
          ({ u, phi, warping }) => u.length === 3 && phi.length === 3 && Number.isFinite(warping),
        ),
      ).toBe(true);

      // Asked for again, the same field comes back rather than being re-read.
      expect(await session.getResult({ loadCaseId: 101 })).toBe(result);

      const modalResult = await session.getResult({ loadCaseId: eigenmode.id });
      expect(modalResult.nodes.ids.length).toBe(geometry.nodes.length);
      expect(modalResult.extent).toBeGreaterThan(0);
    } finally {
      await session.dispose();
    }
  });

  developmentIt(
    "reads a trussed model whose every section is welded from plates",
    "main-3.cdb",
    async () => {
      const session = developmentSession("main-3.cdb");
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
        expect(
          girder.ineffective.every(({ points }) => points.every(([, z]) => z >= -0.2602)),
        ).toBe(true);
        // And a section nothing was taken out of says nothing at all.
        expect(geometry.sections.filter(({ ineffective: areas }) => areas).length).toBe(1);
      } finally {
        await session.dispose();
      }
    },
  );

  developmentIt(
    "keeps the seventh beam degree of freedom and its unit-warping section data",
    "main-4.cdb",
    async () => {
      const session = developmentSession("main-4.cdb");
      try {
        await session.describe();
        const geometry = await session.getGeometry();
        const plateSections = geometry.sections.filter(({ shape }) => shape?.kind === "plates");
        expect(plateSections.length).toBeGreaterThan(0);
        const warpedPlates = plateSections.flatMap(({ shape }) =>
          shape.plates.filter(({ unitWarping }) => unitWarping?.some((value) => value !== 0)),
        );
        expect(warpedPlates.length).toBeGreaterThan(0);
        expect(warpedPlates.every(({ unitWarping }) => unitWarping.every(Number.isFinite))).toBe(
          true,
        );

        const result = await session.getResult({ loadCaseId: 10201 });
        expect(result.components).toBe(7);
        let largestNodeWarping = 0;
        for (let at = 6; at < result.nodes.values.length; at += result.components) {
          largestNodeWarping = Math.max(largestNodeWarping, Math.abs(result.nodes.values[at]));
        }
        expect(largestNodeWarping).toBeGreaterThan(0);
        const largestStationWarping = Math.max(
          ...result.elements.flatMap(({ stations }) =>
            stations.map(({ warping }) => Math.abs(warping)),
          ),
        );
        expect(largestStationWarping).toBeGreaterThan(0);
      } finally {
        await session.dispose();
      }
    },
  );
});
