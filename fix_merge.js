const fs = require('fs');
const file = 'extensions/memory-hybrid/backends/facts-db.ts';
let code = fs.readFileSync(file, 'utf8');

const regex = /constructor\(dbPath: string, options\?: \{ fuzzyDedupe\?: boolean \}\) \{[\s\S]*?<<<<<<< HEAD[\s\S]*?=======\n>>>>>>> origin\/main/;

const replacement = `constructor(dbPath: string, options?: { fuzzyDedupe?: boolean }) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);

    try {
      FactsDB.verifyFts5Support(db);
    } catch (err) {
      try {
        db.close();
      } catch {
        // Ignore close errors during failure cleanup
      }
      throw err;
    }

    super(db, {
      foreignKeys: true,
      customPragmas: ["PRAGMA synchronous = NORMAL", "PRAGMA wal_autocheckpoint = 1000"],
    });
    this.dbPath = dbPath;
    this.fuzzyDedupe = options?.fuzzyDedupe ?? false;`;

code = code.replace(regex, replacement);
fs.writeFileSync(file, code);
