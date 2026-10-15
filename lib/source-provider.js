const fs = require("node:fs");
const path = require("node:path");

class SofistikSourceProvider {
  constructor(options = {}) {
    this.id = "graviss-sofistik";
    this.exists = options.exists || ((filePath) => fs.existsSync(filePath));
    this._Session = options.Session || null;
    this.environment = options.environment;
  }

  get Session() {
    return (this._Session ||= require("./sofistik-session").SofistikSession);
  }

  set Session(Session) {
    this._Session = Session;
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
      filePath: filePath ? path.resolve(filePath) : null,
    });
  }

  resolveSource(document, filePath) {
    if (typeof document.source === "string" && document.source.trim()) {
      const source = document.source.trim();
      if (!filePath && !path.isAbsolute(source)) return null;
      const sourcePath = path.resolve(filePath ? path.dirname(filePath) : "", source);
      return path.extname(sourcePath).toLowerCase() === ".cdb" ? sourcePath : null;
    }
    if (!filePath) return null;
    const parsed = path.parse(filePath);
    const candidate = path.join(parsed.dir, `${parsed.name}.cdb`);
    return this.exists(candidate) ? candidate : null;
  }
}

module.exports = { SofistikSourceProvider };
