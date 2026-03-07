## 2026.3.71 (2026-03-07)

Documentation and UX: benefits-first messaging, multilingual callout, and smarter analyze-feedback-phrases (sentiment pre-filter, 30/3-day window, model-agnostic).

---

### What’s in this release

- **Docs: why first** — README and getting-started docs lead with plain-English benefits (short- and long-term, personal/tuned, right context) before technical detail.
- **Multilingual** — README and benefits now highlight that the plugin works in your language and adapts (build-languages, feedback-phrase learning).
- **analyze-feedback-phrases** — Sentiment pre-filter with nano-tier model; only positive/negative messages go to the heavy-tier phrase extractor. First run uses 30 days, later runs 3 days (for weekly nightly). Fully model-agnostic (nano + heavy from config).
- **Changelog & release notes** — This release and CHANGELOG updated for 2026.3.71.

---

### Documentation (details)

- **README:** New section “Why you’ll want this — in plain English” with short-term and long-term benefits, bullets (remembers you, recalls the right stuff, learns from reactions, gets more personal, multilingual). Technical comparison table moved under “Why use this? (under the hood)”. Getting-started doc table links to the new section.
- **QUICKSTART, FEATURES, HOW-IT-WORKS, FAQ:** Benefits-first intros and links to README for the “why”. QUICKSTART tagline: “Get an agent that remembers you and gets better at giving the right context over time.”
- **CLI-REFERENCE, SELF-CORRECTION-PIPELINE:** analyze-feedback-phrases described with nano pre-filter, auto 30/3 days, model-agnostic; “Making it automatic” note removed (behavior is default for nightly).

---

### analyze-feedback-phrases (details)

- **Pre-filter:** User messages that already match reinforcement/correction regexes are skipped. Remaining messages are batched and sent to a **nano-tier** model for sentiment (positive_feedback / negative_feedback / neutral). Only positive/negative messages are sent to the heavy-tier model for phrase extraction. If none remain, the heavy call is skipped.
- **Window:** When `--days` is omitted: **30 days** the first time (or when no `.user-feedback-phrases.json` exists), **3 days** on subsequent runs. Suited for a weekly nightly job.
- **Model-agnostic:** Nano model from `getLLMModelPreference(..., "nano")` / `getDefaultCronModel(..., "nano")`; heavy from existing config. Uses `chatCompleteWithRetry` for sentiment; no provider-specific code.
- **Persistence:** `UserFeedbackPhrases` includes `initialRunDone`; saved when using `--learn`. Used to choose 30 vs 3 days on the next run.

---

### Upgrade

```bash
openclaw hybrid-mem upgrade 2026.3.71
```

Or from a clean install:

```bash
npx -y openclaw-hybrid-memory-install 2026.3.71
```

Restart the gateway after upgrading.
