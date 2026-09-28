/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS preload */
// TypeScript preserves @/ imports when compiling CommonJS tests. Resolve them only
// inside this test process; the production bundler keeps its own alias handling.
const Module = require("node:module");
const path = require("node:path");
const original = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith("@/"))
    request = path.join(__dirname, "../.test-dist/src", request.slice(2));
  return original.call(this, request, parent, ...rest);
};
