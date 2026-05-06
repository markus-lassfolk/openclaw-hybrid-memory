# Release notes — OpenClaw Hybrid Memory **2026.5.60**

**Release date:** 2026-05-06  
**Previous published release (GitHub / npm):** **2026.4.273** (2026-04-27)

This document is for **operators and integrators**: what changed since the last **public** drop, why it matters, and how to upgrade safely.

---

## Should I upgrade?

**Yes, if** you run **OpenClaw 2026.5.x** (or plan to soon), you install **`openclaw-hybrid-memory` from npm**, or you saw any of these symptoms:

| Symptom | What 2026.5.60 does |
|--------|----------------------|
| Plugin rejected: extension points at **TypeScript** without a built file | Published package ships **`dist/index.js`** + types; **`openclaw.extensions`** targets **`./dist/index.js`**. |
| **`npm install`** fails with **`ETARGET`** / **`@duckflux/core`** | **`openclaw`** peer is **`>=2026.5.0 <2027`**; CI **smoke-install** catches resolver regressions. |
| Gateway log spam: **`http route registration missing path`** | Routes go through **`createSafeRegisterHttpRoute`**; dashboard root is registered **without a trailing slash**. |
| **`plugin must declare contracts.tools before registering agent tools`** | **`openclaw.plugin.json`** now includes **`contracts.tools`** listing every agent tool name (kept in sync with code via a contract test). |
| SQLite **`CHECK constraint failed`** on **`episodes`** or **`audit_log`** after upgrading outcomes | Runtime detects legacy DDL and **normalizes outcomes** on insert/read so old DB files keep working. |

**Stay on 2026.4.x** only if you must keep a **gateway older than OpenClaw 2026.5.0**; this plugin line is aligned with **2026.5.x** peers and validation.

---

## What you get (high level)

1. **Shipped compiled plugin** — **`tsdown`** builds a multi-file **`dist/`** ESM tree. **`npm pack` / `npm publish`** run **`prepack`** so the tarball always contains the same layout CI verifies.

2. **Correct paths from `dist/`** — CLI, prompts, **`package.json`**, and **`openclaw.plugin.json`** resolve from the **plugin root** (directory that contains **`openclaw.plugin.json`**), not from **`dist/`** by accident.

3. **Safer HTTP registration** — Paths are validated before they reach the gateway, which stops empty or malformed route registrations from producing noisy or broken routes.

4. **Tool contract declaration** — OpenClaw **2026.5+** expects **`contracts.tools`** in the plugin record **before** tools register. The manifest now lists **all** tool names; tests fail if code and JSON drift apart.

5. **Older SQLite databases** — If your **`facts.db`** was created with older **`CHECK`** clauses on **`episodes.outcome`** or **`audit_log.outcome`**, inserts no longer fail when the app uses newer outcome strings (**`failure`**, **`unknown`**, **`skipped`**).

6. **Stronger CI** — Publish manifest checks run after a real **`npm ci` + build`**; **`verify-publish`** uses **`npm pack --dry-run --ignore-scripts`** and an explicit shrinkwrap probe so checks stay honest without accidentally triggering full **`prepack`** during verification.

---

## Gateway requirement

- **OpenClaw:** **`>=2026.5.0`** and **`<2027`** (see **`peerDependencies`** on the npm package).
- After upgrading the plugin, **restart the gateway** so the new manifest, **`dist/`** entry, and routes load cleanly.

---

## Upgrade commands

**Global CLI style:**

```bash
npm install -g openclaw-hybrid-memory@2026.5.60
```

**Project-local:**

```bash
npm install openclaw-hybrid-memory@2026.5.60
```

If you use the **`openclaw-hybrid-memory-install`** helper package, bump it to **2026.5.60** as well so versions stay aligned.

---

## SQLite / database notes

- No manual migration is **required** for the legacy **`CHECK`** compatibility layer: it keys off live **`sqlite_master`** DDL.
- If you maintain **forked migrations**, see comments in **`facts-migrations.ts`** and **`utils/sqlite-outcome-compat.ts`** for how runtime behavior differs from a full table rebuild.

---

## Issues and PRs covered in this line of work

Packaging and gateway compatibility (**#1171**–**#1174**), legacy DB outcomes (**#1178**, **#1179**), tool contracts (**#1180**), and follow-up CI / verify hardening from **PR [#1177](https://github.com/markus-lassfolk/openclaw-hybrid-memory/pull/1177)**.

---

## Full technical changelog

See **[CHANGELOG.md](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/CHANGELOG.md)** — section **`[2026.5.60]`**.

---

## Earlier draft notes (2026.5.50)

An internal **2026.5.50** changelog draft described the same packaging work before the version was advanced to **2026.5.60** for publication. **2026.5.60** is the single published **2026.5.x** target that also includes SQLite compat, **`contracts.tools`**, and CI/verify follow-ups.
