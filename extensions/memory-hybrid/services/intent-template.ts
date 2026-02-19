/**
 * Intent template for multilingual keyword and pattern generation.
 * The LLM uses these intents (not literal translation) to produce natural
 * equivalents per language: phrasing, word order, and extraction building blocks.
 */

import type { KeywordGroup } from "../utils/language-keywords.js";

/** Human-readable intent of each keyword group. Sent to LLM so it produces natural equivalents. */
export const KEYWORD_GROUP_INTENTS: Record<KeywordGroup, string> = {
  triggers:
    "Phrases that indicate the user wants to remember something: preferences, decisions, identity, credentials, or facts. Include single words and common sentence starters. Consider how speakers naturally introduce memorable information (e.g. 'I prefer', 'my X is', 'we decided').",
  categoryDecision:
    "Phrases that signal a past decision or choice (what was chosen, selected, or decided). Include verbs and phrases like 'chose X over Y', 'decided to use', 'went with'.",
  categoryPreference:
    "Verbs and short phrases that express preference or desire: like, love, hate, want, need, prefer.",
  categoryEntity:
    "Phrases that introduce a person/entity or contact info: name, email, phone, 'is called', identifiers.",
  categoryFact:
    "Phrases that state a fact about someone/something: birth, location, job, 'is/are', 'has/have'. Include common copula and possession phrasing.",
  decayPermanent:
    "Phrases that indicate long-term or permanent information: decisions, architecture choices, 'always use', 'never use'.",
  decaySession:
    "Phrases that indicate temporary, session-scoped state: 'right now', 'this session', 'currently debugging'.",
  decayActive:
    "Phrases that indicate current work or short-term focus: 'working on', 'need to', 'todo', 'blocker', 'sprint'.",
  /** Issue #39: Directive extraction — phrases where user instructs agent to remember or change behavior. */
  directiveSignals:
    "Phrases indicating the user wants the agent to remember something or change future behavior. Include: explicit memory requests ('remember that', 'don't forget', 'keep in mind'), future behavior changes ('from now on', 'next time', 'going forward'), absolute rules ('always', 'never', 'you must'), preferences ('I prefer', 'I'd rather', 'default to'), warnings ('be careful with', 'watch out for', 'avoid'), procedural instructions ('first check', 'before you do', 'step 1 is always'), implicit corrections ('no, use', 'the other one', 'that's the old way'), emotional emphasis (ALL CAPS, multiple exclamation marks), and conditional rules ('when X happens', 'if you see', 'only when'). These are not questions but directives — the user is telling the agent how to behave.",
  /** Issue #40: Reinforcement extraction — phrases where user praises or approves of agent behavior. */
  reinforcementSignals:
    "Phrases indicating the user is praising or approving of the agent's behavior, output, or method. Include: explicit approval ('perfect', 'exactly', 'spot on', 'you nailed it', 'correct'), emotional praise ('love it', 'brilliant', 'amazing', 'excellent'), method confirmation ('yes, like that', 'keep this format', 'this is how it should be'), relief/finally ('finally!', 'now you get it', 'at last'), comparative praise ('much better', 'huge improvement', 'better than before'), encouragement ('keep doing this', 'more of this', 'don't change'), feature praise ('formatting is perfect', 'love the detail', 'great structure'), and sharing signals ('going to show this', 'saving this', 'bookmarked'). These are not corrections but positive reinforcement — the user is saying 'yes, do more of this'.",
};

/** Structural patterns we need for trigger detection (sentence-level). */
export const STRUCTURAL_TRIGGER_INTENTS = {
  firstPersonPreference:
    "First-person preference statement: subject (I/we) + verb (like, prefer, want, need, love, hate) + object. Provide natural equivalents: e.g. 'I prefer X', 'we like Y'. Include common word orders and particles for this language.",
  possessiveFact:
    "Possessive fact: 'my X is Y' or 'X's Y is Z'. How do speakers say 'my [thing] is [value]' or '[person]'s [thing] is [value]'? Provide phrase patterns or typical starters.",
  alwaysNeverRule:
    "Always/never rule: 'always do X', 'never do Y'. How are universal rules or habits stated? Provide typical adverbs and phrasing.",
};

/** Extraction pattern intents: we need building blocks to build safe regex. */
export const EXTRACTION_INTENTS = {
  decision: {
    description:
      "Decision with optional rationale: ' [subject] decided/chose to use X [because/since/for] Y '. Capture: (1) what was chosen, (2) optional reason.",
    verbs: "Verbs meaning decided, chose, picked, selected, went with (past tense).",
    connectors: "Words introducing reason: because, since, for, due to, over.",
  },
  choiceOver: {
    description:
        "Explicit choice: ' use X over Y ' or ' prefer X instead of Y '. Capture: (1) chosen thing, (2) rejected thing, (3) optional reason.",
      verbs: "Verbs: use, using, chose, prefer, picked.",
      rejectors: "Phrases: over, instead of, rather than.",
      connectors: "Reason: because, since, for.",
  },
  convention: {
    description: "Always/never rule: ' always X ' or ' never X '. Capture: (1) the rule. Value is 'always' or 'never'.",
    always: "Words for 'always' (and formal variants).",
    never: "Words for 'never' (and formal variants).",
  },
  possessive: {
    description: "Possessive fact: ' my X is Y ' or ' X's Y is Z '. Capture: (1) possessor or 'user', (2) key, (3) value.",
    possessiveWords: "Words for 'my', 'our', or possessive marker; or proper noun + possessive.",
    isWords: "Copula: is, are, was (and equivalents).",
  },
  firstPersonPreferenceExtract: {
    description: "First-person preference: ' I prefer/like/want X '. Capture: (1) verb, (2) object. Entity=user.",
    subject: "First-person subject: I, we (and formal/informal).",
    verbs: "Preference verbs: prefer, like, love, hate, want, need, use.",
  },
  nameIntro: {
    description: "Name introduction: ' [I am] called X ' or ' name is X '. Capture: (1) name. Entity=entity, key=name.",
    verbs: "Phrases/verbs: is called, call me, name is, heter (Swedish), heißen (German), etc.",
  },
};
