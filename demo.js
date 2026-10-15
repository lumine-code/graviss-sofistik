// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: ["graviss"],
  viewport: { width: 1400, height: 900 },
  async before() {},
  async prepare(context) {
    const { lumine, state, fixture, open } = context;
    const source = process.env.LUMINE_DEMO_CDB;
    if (!source)
      throw new Error("Set LUMINE_DEMO_CDB to a real SOFiSTiK CDB file approved for screenshots");
    const fs = require("node:fs");
    const digest = require("node:crypto")
      .createHash("sha256")
      .update(fs.readFileSync(source))
      .digest("hex");
    if (digest !== "0c5e09cb24b0313a1dff55383b1ac296ca500ec166b75c679d618acceb2a1275")
      throw new Error(
        "Use the reviewed truss-model CDB; see demo/sofistik-model/notes.txt for its checksum.",
      );
    fs.copyFileSync(source, fixture("sofistik-model/model.cdb"));
    state.editor = await open("sofistik-model/notes.txt");
    await lumine.project.setPaths([fixture("sofistik-model")]);
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Inspect a truss model imported from SOFiSTiK CDB with its element filters.",
      timeout: 60000,
      async run(context) {
        const { lumine, state, waitFor, fixture } = context;
        {
          state.graviss = await lumine.workspace.open(fixture("sofistik-model/model.grv"));
          await lumine.workspace.paneForItem(state.editor).destroyItem(state.editor, true);
          await waitFor(
            () =>
              Boolean(state.graviss.renderer && state.graviss.geometry && !state.graviss.loading) &&
              !document.body.innerText.includes("Unable to") &&
              !document.body.innerText.includes("No model"),
            "complete structural geometry",
            60000,
          );
        }
        {
          await lumine.workspace.open("graviss://filter");
          lumine.workspace.getRightDock().setState({ size: 300 });
          await waitFor(
            () => document.querySelector(".graviss-panel")?.getBoundingClientRect().width > 200,
            "model filter panel",
          );
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          const renderer = state.graviss.renderer;
          renderer.setProjection("orthographic");
          for (const name of [
            "nodes",
            "supports",
            "springs",
            "couplings",
            "mesh",
            "grid",
            "axes",
            "localAxes",
          ])
            state.graviss.setVisibility(name, false);
          renderer.fitView(new renderer.THREE.Vector3(-0.65, -1, -0.8), renderer.worldUp);
          await state.graviss.save();
        }
      },
      ready({ state }) {
        return Boolean(
          state.graviss?.renderer &&
          !state.graviss.loading &&
          document.querySelector(".graviss canvas"),
        );
      },
    },
  ],
  async cleanup() {},
};
