// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: ["graviss"],
  viewport: { width: 1200, height: 820 },
  async before() {},
  async prepare(context) {
    const { lumine, state, fixture, open } = context;
    const source = process.env.LUMINE_DEMO_CDB;
    if (!source)
      throw new Error("Set LUMINE_DEMO_CDB to a real SOFiSTiK CDB file approved for screenshots");
    const fs = require("node:fs");
    fs.copyFileSync(source, fixture("sofistik-model/model.cdb"));
    state.editor = await open("sofistik-model/notes.txt");
    await lumine.project.setPaths([fixture("sofistik-model")]);
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Read real SOFiSTiK CDB geometry in the Graviss viewport.",
      timeout: 60000,
      async run(context) {
        const { lumine, state, waitFor, fixture } = context;
        {
          state.graviss = await lumine.workspace.open(fixture("sofistik-model/model.grv"));
          await lumine.workspace.paneForItem(state.editor).destroyItem(state.editor, true);
          await waitFor(
            () =>
              Boolean(document.querySelector(".graviss canvas")) &&
              !document.body.innerText.includes("Unable to") &&
              !document.body.innerText.includes("No model"),
            "step 1",
            60000,
          );
        }
        {
          lumine.commands.dispatch(lumine.views.getView(state.graviss), "graviss:view-isometric");
          lumine.commands.dispatch(lumine.views.getView(state.graviss), "graviss:fit-view");
        }
      },
      ready() {
        return Boolean(document.querySelector(".graviss canvas"));
      },
    },
  ],
  async cleanup() {},
};
