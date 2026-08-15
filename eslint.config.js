const js = require("@eslint/js");
const n = require("eslint-plugin-n");
const globals = require("globals");
const prettier = require("eslint-config-prettier");

const runtimeModules = ["lumine"];

module.exports = [
  { ignores: ["build/**", "node_modules/**"] },
  js.configs.recommended,
  n.configs["flat/recommended-script"],
  {
    files: ["**/*.js", "**/*.jsx"],
    settings: {
      n: { version: ">=24.0.0", tryExtensions: [".js", ".jsx", ".json", ".node"] },
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.browser,
        lumine: "readonly",
      },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "n/no-missing-require": ["error", { allowModules: runtimeModules }],
      "n/no-unpublished-require": ["error", { allowModules: runtimeModules }],
      "n/no-extraneous-require": ["error", { allowModules: runtimeModules }],
    },
  },
  {
    files: ["eslint.config.js", "spec/**"],
    languageOptions: {
      globals: { ...globals.jasmine, conditionPromise: "readonly" },
    },
    rules: {
      "n/no-unpublished-require": "off",
      "n/no-extraneous-require": "off",
    },
  },
  prettier,
];
