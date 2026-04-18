---
layout: default
title: Scenarios & benefits
parent: Getting Started
nav_order: 2
---

# Scenarios & benefits

Hybrid Memory is built for **people who use an AI assistant as a partner**, not a one-off chat. It matters most when memory needs to be durable, local-first, and inspectable rather than merely clever. These are the situations where it pays off.

---

## Before and after

```
  Typical assistant              Hybrid Memory
  ----------------              ---------------
  New chat = blank slate   →    Past context when it matters
  You repeat yourself      →    Say important things once
  Generic answers          →    Replies match how you work
```

The [repository README](https://github.com/markus-lassfolk/openclaw-hybrid-memory#see-the-difference) also includes a **Mermaid** diagram (renders on GitHub).

---

## Scenario: The standing meeting

**You:** Last month you told the agent your team’s standup is **Tue/Thu 9am**, you **hate scheduling over lunch**, and **Alice** owns the API contract.

**Without memory:** Next week you ask to “find a slot with Alice” and the assistant suggests 12:30 — you correct it again.

**With memory:** The agent already *knows* your constraints and who owns what. You spend less time correcting and more time deciding.

---

## Scenario: The long-running project

**You:** A multi-week effort with evolving decisions — stack choices, naming, “we decided not to use X.”

**Without memory:** You paste a summary into every thread or risk the model contradicting last week’s decision.

**With memory:** Decisions and rationale accumulate. When you ask “what did we pick for auth?”, recall surfaces the right facts instead of a guess.

---

## Scenario: “I’m sure we talked about this”

**You:** You remember a detail but not the exact wording — a client name, a bug title, a preference.

**Without memory:** You scroll old chats or give up.

**With memory:** You ask in natural language; **semantic recall** matches the *idea*, not only the precise phrase. Structured lookup still helps for names, IDs, and categories.

*(How search and ranking work under the hood: [How it works](HOW-IT-WORKS), [Retrieval modes](RETRIEVAL-MODES).)*

---

## Scenario: Staying organized without micromanaging

**You:** You want the assistant to remember what matters but not grow an infinite junk drawer.

**With memory:** **Tiering**, **decay**, and **maintenance jobs** (configurable) keep memory **fresh** and **bounded**. You can tune how aggressive that is; see [Decay & pruning](DECAY-AND-PRUNING) and [Operations](OPERATIONS).

---

## What success feels like

| You notice… | Because… |
|-------------|----------|
| Fewer “I already told you” moments | Relevant memories are pulled into context automatically when configured |
| Less copy-paste from old threads | Long-term facts live outside a single conversation transcript |
| Answers that fit *your* defaults | Preferences and decisions persist |
| You can explain why a memory showed up | Search, verification, and provenance give you proof paths |
| A system you can trust over weeks | Background consolidation, optional reflection, and cleanup run on a schedule you control |

---

## Next steps

- [Quick start](QUICKSTART) — install and verify
- [How it works](HOW-IT-WORKS) — capture, recall, and background jobs
- [Examples](EXAMPLES) — recipes for real setups
