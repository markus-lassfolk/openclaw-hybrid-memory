# Copilot Instructions — openclaw-hybrid-memory

## Project Context

This is **OpenClaw hybrid-memory**, a TypeScript/Node.js plugin that provides persistent memory for AI agents using a hybrid storage backend:
- **SQLite** via `better-sqlite3` for structured metadata and full-text search
- **LanceDB** for vector embeddings and semantic similarity search

TypeScript strict mode is enabled (`"strict": true` in tsconfig).

## Module Structure

```
extensions/memory-hybrid/
├── backends/       # SQLite and LanceDB storage adapters
├── services/       # Business logic (memory CRUD, search, ranking)
├── setup/          # Initialization and schema migration
└── tests/          # Unit and integration tests
```

## Review Focus Areas

When reviewing code in this repository, prioritize:

1. **TypeScript correctness** — No implicit `any`, proper null checks, exhaustive type guards
2. **SQLite query safety** — All queries must use parameterized statements; never interpolate user input into SQL strings
3. **Error handling** — All DB operations must handle errors explicitly; no silent failures
4. **Test coverage** — New behavior should have corresponding tests in `tests/`
5. **Security** — Watch for credential exposure, path traversal, and insecure defaults

## Key Patterns

- All SQLite operations use the **synchronous** `better-sqlite3` API (no `async`/`await` for DB calls)
- Vector search is performed via **LanceDB**; results are re-ranked by the service layer
- Schema migrations live in `setup/` and run at plugin init time
- Tests use the project's own test runner — check `package.json` scripts for the test command

## Review Behavior

- Provide **inline suggestions** on specific lines where possible
- Focus on **correctness and security** over style
- Do **not** auto-commit suggested changes — leave them for the author to review
- Flag any SQL string concatenation as a blocking issue
- Flag any `any` type that could be narrowed as a suggestion
