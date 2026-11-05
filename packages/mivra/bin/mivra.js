#!/usr/bin/env node
// Kept to syntax any Node can parse, so an old Node gets this message rather than a syntax error.
var parts = process.versions.node.split(".").map(Number);
if (parts[0] < 22 || (parts[0] === 22 && parts[1] < 14)) {
  console.error("Mivra needs Node.js 22.14 or newer; this is " + process.version + ".");
  console.error("Install a newer Node from https://nodejs.org, or run Mivra with Docker: see https://github.com/okhay-p/mivra#readme");
  process.exit(1);
}
import("../dist/cli.js").then(function (cli) {
  return cli.main(process.argv.slice(2));
}).then(function (code) {
  if (typeof code === "number") process.exitCode = code;
}, function (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
