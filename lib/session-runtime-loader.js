let pending;

function load() {
  pending ||= import("./session-runtime.js")
    .then((namespace) => namespace.default ?? namespace)
    .catch((error) => {
      pending = null;
      throw error;
    });
  return pending;
}

module.exports = { load };
