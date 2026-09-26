"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- the probe is what a CommonJS parser would do */
/*
 * Loaded by probe-child.fixtures.ts after the lockdown: what a CommonJS parser (yauzl is one)
 * could try through its own `require` and `module`. Returns the outcome of each attempt.
 */
module.exports = function probe(attempt) {
  const Module = module.constructor;
  return [
    ["cjs-require-vm", () => require("vm")],
    ["cjs-require-http-client", () => require("_http_client")],
    ["cjs-require-net", () => require("node:net")],
    ["cjs-load-vm", () => Module._load("vm", module, false)],
    ["cjs-load-tls-wrap", () => Module._load("_tls_wrap", module, false)],
    ["cjs-register-hooks", () => Module.registerHooks({ resolve: (s, c, n) => n(s, c) })],
    ["cjs-register", () => Module.register("data:text/javascript,")],
    ["cjs-require-fs", () => require("fs")],
  ].map(([name, action]) => attempt(name, action));
};
