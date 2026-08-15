const { Disposable } = require("lumine");
const { SofistikEnvironment } = require("./environment");
const { SofistikSourceProvider } = require("./source-provider");

module.exports = {
  activate() {
    this.ensureComponents();
  },

  deactivate() {
    this.environmentProvider = null;
    this.environment = null;
    this.sourceProvider = null;
  },

  ensureComponents() {
    this.environment ||= new SofistikEnvironment({
      environmentProvider: this.environmentProvider,
    });
    this.sourceProvider ||= new SofistikSourceProvider({ environment: this.environment });
  },

  provideGravissSource() {
    this.ensureComponents();
    return this.sourceProvider;
  },

  consumeSofistikEnvironment(service) {
    this.ensureComponents();
    const provider = service?.provider || service;
    if (typeof provider?.resolve !== "function") {
      throw new TypeError("The sofistik.environment service requires a resolver.");
    }
    this.environmentProvider = provider;
    this.environment.setEnvironmentProvider(provider);
    return new Disposable(() => {
      if (this.environmentProvider !== provider) return;
      this.environmentProvider = null;
      this.environment?.setEnvironmentProvider(null);
    });
  },
};
