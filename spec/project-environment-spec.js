const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SofistikEnvironmentResolver } = require("@lumine-code/sofistik-env");

describe("Graviss SOFiSTiK project context", () => {
  let temporaryRoot, previousProjectPaths, session, mainModule;

  beforeEach(async () => {
    previousProjectPaths = lumine.project.getPaths();
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "graviss-project-context-"));
    const pack = await lumine.packages.activatePackage("graviss-sofistik");
    mainModule = pack.mainModule;
  });

  afterEach(async () => {
    await session?.dispose();
    session = null;
    lumine.project.setPaths(previousProjectPaths);
    await lumine.packages.deactivatePackage("graviss-sofistik");
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("selects the owning view's root definition for an external CDB and snapshots its native options", async () => {
    const projectPath = path.join(temporaryRoot, "project");
    const viewDirectory = path.join(projectPath, "views");
    const externalPath = path.join(temporaryRoot, "external");
    const installationRoot = path.join(temporaryRoot, "installed");
    const installPath = path.join(installationRoot, "2024", "SOFiSTiK 2024");
    fs.mkdirSync(viewDirectory, { recursive: true });
    fs.mkdirSync(externalPath);
    fs.mkdirSync(path.join(installPath, "interfaces", "64bit"), { recursive: true });
    fs.writeFileSync(path.join(installPath, "wps.exe"), "");
    fs.writeFileSync(path.join(installPath, "interfaces", "64bit", "sof_cdb_w_edu-2024.dll"), "");
    const definition = path.join(projectPath, "sofistik.def");
    fs.writeFileSync(
      definition,
      "SOF_VERSION = 2024\nSOF_LANGUAGE = DE\nSOF_EDITION = educational\n",
    );
    fs.writeFileSync(
      path.join(externalPath, "sofistik.def"),
      "SOF_VERSION = 2026\nSOF_LANGUAGE = EN\nSOF_EDITION = professional\n",
    );
    const databasePath = path.join(externalPath, "model.cdb");
    fs.writeFileSync(databasePath, "");
    const viewPath = path.join(viewDirectory, "model.grv");
    const document = {
      title: "External Model",
      source: path.relative(viewDirectory, databasePath),
    };
    fs.writeFileSync(viewPath, JSON.stringify(document));
    lumine.project.setPaths([projectPath, externalPath]);

    const resolver = new SofistikEnvironmentResolver({ root: installationRoot });
    const resolve = spyOn(resolver, "resolve").and.callThrough();
    mainModule.environment.resolver = resolver;
    session = mainModule.provideGravissSource().createSession({
      filePath: viewPath,
      viewDocument: { getData: () => document },
    });
    expect(session.projectPath).toBe(projectPath);
    expect(session.databasePath).toBe(databasePath);
    const selected = await session.resolveEnvironment();
    expect(selected.version).toBe("2024");
    expect(selected.edition).toBe("educational");
    expect(resolve.calls.mostRecent().args[0].projectPath).toBe(projectPath);
    expect(resolve.calls.mostRecent().returnValue.language).toBe("de");

    const database = { dispose: jasmine.createSpy("dispose") };
    session.databaseFactory = jasmine.createSpy("databaseFactory").and.returnValue(database);
    expect(await session.getDatabase()).toBe(database);
    expect(session.databaseFactory).toHaveBeenCalledWith(databasePath, {
      version: "2024",
      edition: "educational",
      environmentRoot: installationRoot,
    });
    fs.writeFileSync(definition, "SOF_VERSION = 2026\nSOF_EDITION = professional\n");
    expect(await session.resolveEnvironment()).toBe(selected);
    expect(await session.getDatabase()).toBe(database);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(session.databaseFactory).toHaveBeenCalledTimes(1);
  });
});
