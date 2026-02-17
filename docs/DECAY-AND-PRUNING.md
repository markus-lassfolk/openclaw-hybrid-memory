# Decay and Pruning

Facts have a **decay class** and an optional **expiry time**. The plugin automatically **hard-prunes** expired facts and **soft-decays** confidence for facts nearing expiry. No cron or external jobs are required — everything runs inside the gateway process.

---

## Decay classes

Each fact is assigned one of five decay classes. The class determines **TTL** (time-to-live) and whether **recall refreshes expiry**.

| Class | TTL | Refresh on access? | Typical content |
|-------|-----|--------------------|-----------------|
| **permanent** | Never expires | N/A | Decisions, conventions, name/email/architecture, “always use X” |
| **stable** | 90 days | Yes | General long-lived facts; expiry resets when the fact is recalled |
| **active** | 14 days | Yes | Tasks, WIP, sprints, “working on”, “todo”; expiry resets on recall |
| **session** | 24 hours | No | “Currently debugging”, “right now”, current_file, temp |
| **checkpoint** | 4 hours | No | Checkpoints, preflight state |

TTL values are defined in code (`config.ts`: `TTL_DEFAULTS`). There is no config knob for TTLs; changing them requires editing constants and redeploying.

---

## How decay class is chosen

**At store time** the plugin calls `classifyDecay(entity, key, value, text)` (in `utils/decay.ts`). No LLM — pure heuristics:

1. **Permanent** — If any of:
   - `key` (or `entity`) matches: name, email, api_key, api_endpoint, architecture, decision, birthday, born, phone, language, location
   - Text matches: “decided”, “architecture”, “always use”, “never use”
   - `entity === "decision"` or `entity === "convention"`
2. **Session** — If any of:
   - `key` matches: current_file, temp, debug, working_on_right_now
   - Text: “currently debugging”, “right now”, “this session”
3. **Active** — If any of:
   - `key` matches: task, todo, wip, branch, sprint, blocker
   - Text: “working on”, “need to”, “todo”, “blocker”, “sprint”
4. **Checkpoint** — If `key` (or text) mentions “checkpoint” or “preflight”.
5. **Stable** — Default for everything else.

The `memory_store` tool can override decay class via an explicit `decayClass` parameter. Otherwise heuristics only.

---

## Refresh on access (stable and active)

For facts with `decay_class` **stable** or **active**, when they are used in **recall** (search/lookup results that get injected or used by the agent), the plugin can **refresh** their expiry:

- It updates `last_confirmed_at` and recomputes `expires_at` from the current time plus TTL.
- So frequently recalled facts stay “alive”; unused ones eventually expire.

Permanent/session/checkpoint are not refreshed (permanent never expires; session/checkpoint are short-lived by design).

---

## Pruning (what gets removed)

Two mechanisms run automatically:

### 1. Hard prune (expired facts)

- **What:** Delete rows where `expires_at IS NOT NULL AND expires_at < now`.
- **When:** On gateway **startup** (after DB open), and **every 60 minutes** via a timer.
- **Effect:** Expired facts are removed from SQLite (and should be removed from LanceDB when they’re written there; the single source of truth for expiry is the facts DB).

### 2. Soft decay (confidence then delete)

- **What:**
  - For facts that **have not yet expired** but are past ~**75% of their TTL** (between `last_confirmed_at` and `expires_at`), confidence is multiplied by **0.5**.
  - Then any fact with **confidence &lt; 0.1** is **deleted**.
- **When:** Same 60-minute timer, after the hard prune step.
- **Effect:** Facts that are rarely recalled age out: first their score drops, then they are removed. Frequently recalled stable/active facts keep getting their expiry refreshed, so they don’t hit the 75% window the same way.

Formulae (from `facts-db.ts`):

- Hard: `DELETE FROM facts WHERE expires_at IS NOT NULL AND expires_at < ?`
- Soft decay: `UPDATE facts SET confidence = confidence * 0.5 WHERE expires_at IS NOT NULL AND expires_at > @now AND last_confirmed_at IS NOT NULL AND (@now - last_confirmed_at) > (expires_at - last_confirmed_at) * 0.75 AND confidence > 0.1`
- Then: `DELETE FROM facts WHERE confidence < 0.1`

---

## When things run

| Event | Action |
|-------|--------|
| Gateway start | Hard prune (delete expired); log: `startup prune removed N expired facts` |
| Every 60 minutes | Hard prune, then soft decay; log: `periodic prune — N expired, M decayed` |

No external cron is required. If you stop the gateway, no pruning runs until the next start (and the next 60-minute tick).

---

## CLI

- **`openclaw hybrid-mem prune`**  
  - Default: run both hard prune and soft decay once (same logic as the periodic job).  
  - `--soft`: only soft-decay confidence (no hard delete).  
  - `--dry-run`: only report how many would be hard-pruned (expired count); no writes.

- **`openclaw hybrid-mem backfill-decay`**  
  Re-classify **existing** facts with auto-detected decay classes. Uses current `classifyDecay(entity, key, value, text)` and updates `decay_class` and `expires_at`. Use after changing decay rules or to fix old data that was stored before decay existed.

- **`openclaw hybrid-mem stats`**  
  Shows counts per decay class and “Expired (pending prune)”.

---

## Changing TTLs or adding a decay class

TTLs and class names are in **code**:

- `extensions/memory-hybrid/config.ts`: `DECAY_CLASSES`, `TTL_DEFAULTS`.
- `extensions/memory-hybrid/utils/decay.ts`: `classifyDecay()` and `calculateExpiry()`.

To change a TTL or add a new class (e.g. “ephemeral” with 1-hour TTL):

1. Update `DECAY_CLASSES` and `TTL_DEFAULTS` in `config.ts`.
2. Update `classifyDecay()` in `utils/decay.ts` to return the new class where appropriate.
3. Ensure any code that branches on decay class (e.g. refresh-on-access) handles the new class.
4. Redeploy and optionally run `hybrid-mem backfill-decay` to reclassify existing facts.

There is no config option in `openclaw.json` for decay or TTL.

---

## Related docs

- [FEATURES.md](FEATURES.md) — Overview of categories, decay, tags, auto-classify
- [CONFIGURATION.md](CONFIGURATION.md) — Plugin config (no decay settings)
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — `prune`, `backfill-decay`, `stats`
- [DEEP-DIVE.md](DEEP-DIVE.md) — Storage and recall pipeline
