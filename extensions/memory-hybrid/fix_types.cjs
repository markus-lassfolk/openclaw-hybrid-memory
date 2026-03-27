const fs = require("node:fs");
const glob = require("glob");

// Add edictStore to mock contexts
const files = glob.sync("tests/**/*.test.ts");
files.forEach((f) => {
  let src = fs.readFileSync(f, "utf8");
  if (src.includes("factsDb:") && !src.includes("edictStore:") && src.includes("MemoryToolsContext")) {
    src = src.replace(/(\bfactsDb:\s*[^,]+,)/g, "$1 edictStore: null as any,");
    fs.writeFileSync(f, src);
  }
});
