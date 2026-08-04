# Goal stewardship operator notes

## Managed dispatch broker

`goal_dispatch` is a supported plugin integration, disabled unless goal stewardship is enabled. It requires the **canonical goal UUID**: labels and task text never establish authority. The goal policy must contain a `managed` class with an explicit `allowedAgents` list. The broker creates an opaque, expiring grant and atomically reserves the requested budget before work is started.

The broker uses a JSON ledger protected by `mkdir` locking and atomic rename. Its guarantees are limited to processes sharing a strongly consistent local POSIX filesystem. It is neither a distributed transaction nor a safe guarantee on NFS/other weakly consistent filesystems. The ledger records identifiers, target/runtime, budget, lifecycle state and redacted reasons—not prompts or grant secrets.

For **native** work, `goal_dispatch` can launch through `api.runtime.subagent.run` only when the host supplies that runtime **for the active gateway request**. This request-scoped binding is a supported-runtime prerequisite, not a plugin capability that can be recreated globally. If it is unavailable, the plugin fails closed, releases the reservation, and reports that E2E child completion is unverified; hybrid-memory must not add a global/process fallback. The public `subagent_ended` hook settles native launches where a run id is provided; expiry releases abandoned reservations. The currently public plugin runtime exposes no ACP launcher. ACP requests are reserved but returned as a redacted `dispatch_request` for a trusted host launcher to validate, launch and reconcile. The plugin does not claim a tool-only ACP launch.

## Direct-spawn migration and enforcement

`goalStewardship.dispatchAuthorization.mode` is `disabled` by default, preserving existing behavior.

* `disabled`: no model-tool interception.
* `audit`: permits model-visible `sessions_spawn` (native and ACP) and records direct attempts/would-be denials in `state/goals/dispatch-audit/` for inventory and migration.
* `enforce`: blocks direct model-visible `sessions_spawn` (native and ACP). The public hook has no trusted provenance channel to attach a broker grant to a subsequent model tool call, so there is deliberately **no model-supplied grant exception**.

Migrate managed cron work by having a trusted host launcher call/consume a `goal_dispatch` request, retain the returned dispatch id externally, then reconcile it after the child ends. Administrative/direct Gateway, cron control-plane and other runtime routes outside model-visible `sessions_spawn` do not traverse this hook. Treat them as break-glass/unmanaged until moved to the launcher and write a redacted event shaped as `{route, actor, goalId:null, reason, timestamp}`. This operational boundary is intentional; plugin hooks are not system-wide control-plane enforcement.

## Production deployment contract for dispatch authorization

Do not enable `goalStewardship.dispatchAuthorization.mode: "enforce"` until the
candidate has passed every acceptance check below. `audit` or `disabled` is the
safe state when deployment validation fails or is incomplete.

### Immutable, project-local activation

The gateway-selected **project-local** plugin path is authoritative. A global
copy (including one under a global `node_modules`) is not evidence of the code
that the gateway will load. Never use `rsync`, `cp`, or any direct file copy
into a live `node_modules/openclaw-hybrid-memory` tree. A raw package copy is
not an installation: it can omit the npm-resolved optional native dependency
needed by LanceDB and can leave the running gateway observing a partial tree.

1. Build or obtain one immutable `npm pack` tarball; record its filename,
   version, and checksum.
2. Outside every plugin-discovery directory, unpack that exact tarball into a
   fresh candidate root. Install production dependencies there through npm,
   using the tarball's `npm-shrinkwrap.json` (`npm ci --omit=dev` when the
   shrinkwrap is present and suitable; otherwise the documented npm install
   command that honors it). Do not reuse or mutate the live installation.
3. Before activation, run resolver checks **from the candidate root** for
   `@lancedb/lancedb` and the platform package (on Linux x64 GNU,
   `@lancedb/lancedb-linux-x64-gnu`), then load its native binding. Also import
   the candidate's actual `dist/index` entry point and run `npm ls --omit=dev`
   to prove the complete production dependency closure. Any resolver, native
   binding, import, or dependency-tree failure rejects the candidate.
4. Stop/quiesce the gateway only for the activation window. Atomically rename
   the complete project-local installation to a retained rollback path and
   atomically rename the validated candidate into its place. Do not swap
   individual files or nested `node_modules` directories.
5. Restart through the approved gateway control path. After startup, verify
   from the gateway-selected project-local path—not a global copy—that the
   plugin source is the new tree and that plugin registration succeeded. Check
   the expected plugin/goal-dispatch registration and gateway logs before
   enabling enforcement.

Keep the prior complete installation as the rollback artifact until the
post-start checks pass. If activation or post-start validation fails, perform
one controlled restore of that retained installation, restart once, and leave
dispatch authorization at `audit` or `disabled`. Stop and investigate after
that restore: do not retry swaps or restart/rollback in a loop.

## Governed stewardship-limit updates

Do **not** edit protected Gateway configuration paths. A local administrator can use the narrowly scoped, auditable operator command instead:

```bash
openclaw hybrid-mem stewardship-set globalLimits.maxActiveGoals 6 \
  --approve --actor "ops@example" --reason "Increase approved concurrent-goal capacity" \
  --request-id "change-2026-08-04-goal-capacity"
```

Use `--dry-run` to validate and inspect the old/new value without writing. The command accepts only `globalLimits.maxActiveGoals` and `globalLimits.maxDispatchesPerHour`, both positive safe integers; all other fields fail closed. It requires explicit `--approve`, an actor and a reason, atomically replaces only the plugin config while preserving unrelated Gateway config, serializes updates with a lock, and appends a JSONL audit record beside `openclaw.json` (`stewardship-settings-audit.jsonl`). Reusing a successful `--request-id` is idempotent. Restart the Gateway after a non-dry-run update.
