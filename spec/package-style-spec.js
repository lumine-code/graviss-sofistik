const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

describe("graviss-sofistik package conventions", () => {
  it("keeps metadata and documentation aligned", () => {
    expect(firstProseLine(readme)).toBe(manifest.description);
    expect(manifest.keywords.length).toBeGreaterThanOrEqual(3);
    expect(manifest.keywords.length).toBeLessThanOrEqual(8);
    expect(manifest.keywords.some((keyword) => manifest.name.includes(keyword))).toBe(false);
    expect(Object.keys(manifest).indexOf("backgroundTips")).toBe(
      Object.keys(manifest).indexOf("engines") + 1,
    );
    expect(featureBullets(readme).length).toBeGreaterThanOrEqual(3);
    expect(featureBullets(readme).length).toBeLessThanOrEqual(9);
    expect(readme).toContain("## Installation");
    expect(readme).toContain("## Services");
    expect(readme).not.toMatch(/keymaps|keybindings/i);
  });

  it("is a data package with no commands, menus, or user interface", () => {
    const source = fs.readFileSync(path.join(root, "lib", "main.js"), "utf8");
    expect(source).not.toContain("lumine.commands.add");
    expect(source).not.toContain("addOpener");
    expect(readme).not.toContain("## Commands");
    for (const directory of ["menus", "keymaps", "styles"]) {
      expect(fs.existsSync(path.join(root, directory))).toBe(false);
    }
    expect(fs.existsSync(path.join(root, "lib", "details-pane.js"))).toBe(false);
    expect(fs.existsSync(path.join(root, "lib", "sofistik-details.jsx"))).toBe(false);
    expect(manifest.deserializers).toBeUndefined();
    expect(Object.keys(manifest.providedServices)).toEqual(["graviss.source"]);
    expect(Object.keys(manifest.consumedServices)).toEqual(["sofistik.environment"]);
  });

  it("ships a cross-platform CI definition", () => {
    const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("repository: lumine-code/sofistik-reader");
    expect(workflow).toContain("npm pack --dry-run");
  });

  it("keeps native bindings in the standalone CDB library", () => {
    // A published pin must be an immutable SHA; "file:" is only the local development form.
    expect(manifest.dependencies["@lumine-code/sofistik-reader"]).toMatch(
      /^(?:file:\.\.\/sofistik-reader|github:lumine-code\/sofistik-reader#[0-9a-f]{40})$/,
    );
    expect(fs.existsSync(path.join(root, "binding.gyp"))).toBe(false);
    expect(fs.existsSync(path.join(root, "src", "cdb-reader.cc"))).toBe(false);
    expect(fs.existsSync(path.join(root, "lib", "native-addon.js"))).toBe(false);
    expect(fs.existsSync(path.join(root, "lib", "cdb-worker.js"))).toBe(false);
  });

  it("ships only what a data package delivers", () => {
    // Sample models are development material and live in the untracked .dev
    // directory, so nothing here may reference or publish them.
    expect(manifest.files).toEqual(["lib", "spec"]);
    expect(fs.existsSync(path.join(root, "examples"))).toBe(false);
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toContain(".dev/");
  });
});

function firstProseLine(markdown) {
  return markdown
    .split(/\r?\n/)
    .slice(1)
    .find((line) => line.trim());
}

function featureBullets(markdown) {
  const section = markdown.match(/## Features\r?\n([\s\S]*?)(?=\r?\n## )/)?.[1] || "";
  return section.match(/^- \*\*/gm) || [];
}
