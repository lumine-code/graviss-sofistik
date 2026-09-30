const fs = require("node:fs");
const path = require("node:path");
const { SofistikSession } = require("./sofistik-session");

class SofistikSourceProvider {
  constructor(options = {}) {
    this.id = "graviss-sofistik";
    this.exists = options.exists || ((filePath) => fs.existsSync(filePath));
    this.Session = options.Session || SofistikSession;
    this.environment = options.environment;
  }

  createSession({ viewDocument, filePath }) {
    const document = viewDocument.getData();
    const sourcePath = this.resolveSource(document, filePath);
    if (!sourcePath) return null;
    return new this.Session(sourcePath, {
      title: document.title,
      environment: this.environment,
      // A referenced CDB may live outside the viewer's directory. The .grv owns
      // the context selecting its release and edition, not that external path.
      filePath: path.resolve(filePath),
    });
  }

  resolveSource(document, filePath) {
    if (typeof document.source === "string" && document.source.trim()) {
      const sourcePath = path.resolve(path.dirname(filePath), document.source.trim());
      return path.extname(sourcePath).toLowerCase() === ".cdb" ? sourcePath : null;
    }
    const parsed = path.parse(filePath);
    const candidate = path.join(parsed.dir, `${parsed.name}.cdb`);
    return this.exists(candidate) ? candidate : null;
  }
}

module.exports = { SofistikSourceProvider };
