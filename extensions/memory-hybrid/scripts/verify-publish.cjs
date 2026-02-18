#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
);
if (!pkg.scripts?.postinstall) {
  console.error("postinstall missing from package.json - published package will not rebuild native deps");
  process.exit(1);
}
console.log("OK: postinstall present");
