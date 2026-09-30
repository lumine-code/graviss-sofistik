const { SofistikEnvironment } = require("./environment");
const { SofistikSourceProvider } = require("./source-provider");

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "graviss-sofistik",
      tips: [
        "You can explore a SOFiSTiK model by opening a Graviss .grv document beside its .cdb database.",
      ],
    };
  },

  activate() {
    this.ensureComponents();
  },

  deactivate() {
    this.environment = null;
    this.sourceProvider = null;
  },

  ensureComponents() {
    this.environment ||= new SofistikEnvironment();
    this.sourceProvider ||= new SofistikSourceProvider({ environment: this.environment });
  },

  provideGravissSource() {
    this.ensureComponents();
    return this.sourceProvider;
  },
};
