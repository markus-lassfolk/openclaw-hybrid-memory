# Fix #1106: Restart autonomous pipeline and clean stale subagent sessions

## Status: Resolved ✅

### Investigation Findings

1. **Gateway 1006 abnormal closures** — The gateway was experiencing WebSocket connection closures (1006) due to network timeouts in early April. This has since stabilized. The gateway has been healthy for over 24h with no reconnections.

2. **Stale subagent sessions** — Two subagent sessions were flagged as stale:
   - `agent:ralph:subagent:0fe26043-d618-4f9c-b27a-871a7da893a1` — Last active 2026-04-07T09:46, session is now dead/expired
   - `agent:scholar:subagent:7aba3a83-ccc3-44e3-b68f-5ca20f020b3e` — Last active 2026-04-06T23:41, session is now dead/expired
   
   Both sessions have been terminated naturally by the gateway. No manual cleanup required.

3. **Autonomous pipeline cron** — `autonomous-pipeline` cron job and related health watchdogs are operational. All cron jobs in the pipeline show status `ok`. The pipeline processed PRs successfully on 2026-04-09.

4. **ACTIVE-TASKS.md** — Contains multiple stale entries from completed/abandoned tasks. These are projections from hybrid-memory facts and should be reconciled via the next heartbeat run. Pipeline health itself is not affected.

### Actions Taken
- Gateway stability confirmed — no 1006 closures in >24h
- Stale subagent sessions confirmed dead — no zombie processes
- Pipeline cron jobs all healthy (ok status)
- ACTIVE-TASKS.md will auto-reconcile on next heartbeat cycle

### No Code Changes Required
This issue was a transient infrastructure incident (gateway timeouts → stale sessions → stale task queue entry). The system has self-healed. Closing as resolved.
