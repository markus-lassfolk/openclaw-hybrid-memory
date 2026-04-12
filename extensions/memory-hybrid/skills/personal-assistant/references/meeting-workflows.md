# Meeting Workflows: Preparation, Notes, and Follow-Up

This guide covers meeting preparation, structured note-taking by meeting type, and action item extraction.

## Table of Contents

1. [Pre-Meeting Preparation](#pre-meeting-preparation)
2. [Meeting Types and Note Templates](#meeting-types-and-note-templates)
3. [Action Item Extraction](#action-item-extraction)
4. [Post-Meeting Follow-Up](#post-meeting-follow-up)

## Pre-Meeting Preparation

### Goal

Ensure the user walks into every meeting fully briefed on context, people, and objectives.

### When to Prepare

**Auto-trigger for:**
- Meetings with ≥2 external attendees
- Meetings flagged as "Important" or "High Priority"
- Recurring meetings with "Review" or "Decision" in the title
- Any meeting the user explicitly asks about

**Skip for:**
- 1:1s with frequent collaborators (unless user requests)
- Brief internal check-ins (<15 min)
- Meetings the user organized themselves and already knows the context

### Preparation Checklist

#### 1. Recall Meeting Context

```bash
# Get meeting details
m365-agent-cli calendar show <meeting_id> [--mailbox <user_email>]
```

**Extract:**
- Subject
- Attendees
- Organizer
- Time/duration
- Location (physical or virtual)
- Attached agenda (if any)

#### 2. Recall People Context

For each attendee (especially external ones):
- What's their role?
- When did the user last interact with them?
- What were the outcomes of past meetings?
- Any preferences or sensitivities to be aware of?

**Use `memory_recall`:**
```
Query: "Alice Chen, role, last interaction, preferences"
```

#### 3. Recall Project Context

If the meeting is tied to a known project:
- Current state of the project
- Blockers
- Open questions
- Recent decisions

**Use `memory_recall`:**
```
Query: "Project Alpha status, blockers, recent decisions"
```

#### 4. Gather Background Documents

Check if any documents are attached to the calendar event:
```bash
m365-agent-cli calendar show <meeting_id> --attachments [--mailbox <user_email>]
```

Download and summarize if relevant.

#### 5. Assemble Brief

**Brief template:**
```
📅 Meeting Prep: [Meeting Title]
⏰ [Time] | [Duration] | [Location/Link]

👥 Who:
- [Name] ([Role]) — [Last interaction context]
- [Name] ([Role]) — [Last interaction context]

📌 Purpose:
[What this meeting is about—inferred from context]

🔍 Background:
[Relevant project status, decisions, open questions]

❓ Likely Topics:
[What you expect will be discussed based on context]

✅ What to Bring Up:
[User's open asks, blockers, or commitments relevant to this meeting]
```

#### 6. Deliver Brief

**Timing:** 15-30 minutes before meeting starts (configurable)

**Delivery:** Short summary in chat or via preferred channel (Telegram, email, etc.)

### Example Brief

```
📅 Meeting Prep: Q2 Budget Review
⏰ Today 2:00 PM | 60 min | Conference Room B

👥 Who:
- Alice Chen (CFO) — Last met Apr 1, discussed capital allocation priorities
- Bob Martinez (VP Product) — Pushing for increased R&D budget
- You (CTO)

📌 Purpose:
Finalize Q2 spending across departments, resolve competing requests for limited budget.

🔍 Background:
- Engineering requested $500K for infrastructure (cloud migration)
- Product requested $400K for R&D (new feature development)
- Alice indicated total discretionary budget is $700K this quarter
- Open question: Can we defer cloud migration to Q3?

🔍 Likely Topics:
- Prioritization of infrastructure vs new features
- Timeline flexibility for deferred projects
- Revenue impact of delayed R&D

✅ What to Bring Up:
- Your analysis showing cloud migration ROI is higher long-term
- Proposal to phase R&D spend across Q2/Q3
- You committed to Alice to deliver infrastructure cost breakdown by today (see email thread from Apr 5)
```

## Meeting Types and Note Templates

Different meetings need different notes. Generic notes are low-value.

### Sales / Pipeline Meetings

**Purpose:** Track deal progress, commitments, next steps.

**Template:**
```
# [Client/Prospect Name] — [Date]

## Attendees
- [Client side]
- [Our side]

## Deal Status
- Stage: [Discovery / Proposal / Negotiation / Closing]
- Value: $[amount]
- Close probability: [%]
- Expected close: [date]

## Discussion Highlights
- [Key points that change deal understanding]

## Commitments Made
| Who | What | By When |
|-----|------|---------|
| Us | [Deliverable] | [Date] |
| Them | [Deliverable] | [Date] |

## Objections / Concerns
- [What's blocking the deal]

## Next Steps
1. [Action] (Owner: [Name], Due: [Date])
2. [Action] (Owner: [Name], Due: [Date])

## Follow-Up Date
[When to check in next]
```

**Why this format:** Sales is about moving deals forward. This template captures what changed, what's owed, and what's blocking.

### Board / Governance Meetings

**Purpose:** Record decisions, motions, and dissents—not raw discussion.

**Template:**
```
# Board Meeting — [Date]

## Attendees
- [Board members present]
- [Observers]

## Decisions Made
1. **[Decision]**
   - Motion by: [Name]
   - Seconded by: [Name]
   - Vote: [Outcome]
   - Dissents: [If any, who and why]

## Open Questions Escalated
- [Question requiring board input]
- [Question requiring board input]

## Executive Directives
- [Action assigned to executives, with deadline]

## Next Meeting
[Date and tentative agenda items]
```

**Why this format:** Board meetings are about governance, not operations. Capture decisions and accountability, not minutiae.

### M&A Target Interview

**Purpose:** Gather facts about the acquisition target—exclude unrelated discussion.

**Template:**
```
# [Target Company] Interview — [Date]

## Attendees
- [Target side]
- [Our side]

## Questions & Answers

### Financial
Q: [Question]
A: [Answer]

### Technical
Q: [Question]
A: [Answer]

### Operations
Q: [Question]
A: [Answer]

### Legal / Compliance
Q: [Question]
A: [Answer]

## Red Flags
- [Anything concerning]

## Confirmations Needed
- [Follow-up items to verify]

## Next Steps
- [Further diligence actions]
```

**Why this format:** M&A diligence is about facts. Cleanly separate Q&A by domain for easy reference during decision-making.

### Client / Consulting Meetings

**Purpose:** Track what the client wants, what was promised, what needs delivering.

**Template:**
```
# [Client Name] — [Project Name] — [Date]

## Attendees
- [Client side]
- [Our side]

## Client Requests
1. [What they asked for]
2. [What they asked for]

## What We Promised
| Deliverable | Owner | Due Date | Status |
|-------------|-------|----------|--------|
| [Item] | [Name] | [Date] | [Not started / In progress / Done] |

## Decisions Made
- [Anything that changes scope, timeline, or approach]

## Blockers
- [What's preventing progress, who needs to unblock]

## Next Check-In
[Date and agenda]
```

**Why this format:** Consulting is about delivery. This template ensures nothing slips through cracks.

### Strategy / Planning Meetings

**Purpose:** Capture decisions, open questions, and ownership.

**Template:**
```
# [Topic] Strategy Session — [Date]

## Attendees
- [List]

## Decisions Made
1. [Decision and rationale]
2. [Decision and rationale]

## Open Questions
- [Question requiring further input]
- [Question requiring further input]

## Initiatives Launched
| Initiative | Owner | Milestone 1 | Target Date |
|------------|-------|-------------|-------------|
| [Name] | [Person] | [First deliverable] | [Date] |

## Parking Lot (Deferred Topics)
- [Topic to revisit later]

## Next Session
[Date and focus area]
```

**Why this format:** Strategy is about alignment. Clearly separate what's decided from what's still open.

## Action Item Extraction

### Goal

Turn meeting outcomes into tracked tasks so nothing gets forgotten.

### What Counts as an Action Item

- Someone commits to deliver something by a deadline
- A follow-up is owed (email, call, document)
- A decision requires further work to implement

### What Doesn't Count

- General discussion points with no owner or deadline
- Observations or context-sharing
- Decisions that are complete in the meeting itself

### Extraction Process

#### 1. Identify Commitments During Note-Taking

Flag phrases like:
- "I'll send..."
- "Let me get back to you..."
- "We need to..."
- "By [date], we should..."
- "[Name] will..."

#### 2. Structure Each Action Item

Every action needs:
- **Clear description** (verb + object: "Send budget analysis")
- **Owner** (who's responsible)
- **Deadline** (realistic date, not "soon")

#### 3. Create Tasks

**For user's actions:**
```bash
m365-agent-cli todo create --title "[Description]" --due [YYYY-MM-DD] [--user <user_email>]
```

**For team actions (if using Planner):**
```bash
m365-agent-cli planner create-task --plan "[Project]" --bucket "[Status]" --title "[Description]" --assigned-to <email> --due [YYYY-MM-DD] [--user <user_email>]
```

#### 4. Store in Memory

**Why:** Later, when the user asks "What did I commit to in that Alice meeting?", you can recall instantly.

**Memory entry:**
```
Fact: In Q2 Budget Review meeting on Apr 10 with Alice Chen and Bob Martinez, user committed to:
1. Deliver infrastructure cost breakdown by Apr 10 (completed)
2. Propose phased R&D spend across Q2/Q3 by Apr 15 (in progress)
3. Schedule follow-up with Bob on cloud migration timeline by Apr 12 (pending)
```

### Example Extraction

**Meeting discussion:**
> Alice: "Can you send me the cost breakdown by end of day?"
> User: "Yes, I'll have that to you by 5 PM."
> Bob: "I'll follow up with the vendor on pricing and let you know by Wednesday."

**Extracted tasks:**
1. **User:** "Send infrastructure cost breakdown to Alice" — Due: Today 5 PM
2. **Bob:** "Follow up with vendor on pricing" — Due: Wednesday (if tracking team tasks)

**Memory storage:**
```
Meeting: Q2 Budget Review, Apr 10
- User committed to send Alice infrastructure cost breakdown by 5 PM today
- Bob committed to follow up with vendor on pricing by Wednesday
```

## Post-Meeting Follow-Up

### Immediate Follow-Up (Within 1 Hour)

1. **Distribute notes** (if requested by user)
   - Send to attendees
   - Store in shared drive

2. **Create tasks** for all action items

3. **Store key facts in memory**
   - Decisions
   - Commitments
   - Context for future reference

### 24-Hour Follow-Up

**Check on user's action items:**
- If deadline is today/tomorrow, reminder in morning briefing
- If user hasn't started, offer to help unblock

### 3-Day Follow-Up (for commitments owed TO the user)

**Check if others delivered:**
- If Bob promised something by Wednesday, check Wednesday afternoon
- If not delivered, offer to draft a follow-up: "Bob, just checking in on the vendor pricing update you mentioned in our meeting. Do you have an ETA?"

### Weekly Review

**Aggregate all open items from past week's meetings:**
- What's still pending?
- What's at risk of being forgotten?
- What needs escalation?

**Deliver as a summary:**
```
📊 Weekly Meeting Follow-Up

⚠️ At Risk:
- [Item with missed deadline or no progress]

⏳ In Progress:
- [Item with clear progress]

✅ Completed:
- [Items closed this week]
```

## Advanced: Meeting Prep Automation

### Pattern Detection

After a few meetings, detect patterns:
- "Budget reviews always involve Alice, Bob, and cost breakdowns"
- "Client check-ins always need status on deliverables"

**Offer automation:**
- "Budget review meetings always follow the same pattern. Should I auto-prep a brief based on the standard template?"

### Dynamic Brief Timing

Learn when the user prefers briefs:
- Some users want them the night before
- Some want them 30 min before
- Some want them only on-demand

**Store preference:**
```
Meeting brief timing preference: 30 minutes before meeting start
```

## Summary

Meeting workflows have three phases:

**Before:** Prepare so the user walks in fully briefed
**During:** Take structured notes that drive action
**After:** Extract tasks, follow up on commitments, store context

**Key principles:**
1. **Not all meetings need the same prep** — 1:1s need less than board meetings
2. **Notes should match meeting type** — Sales notes ≠ M&A notes
3. **Every commitment becomes a task** — Don't rely on memory
4. **Follow up on what others owe** — Don't let promises made TO the user slip
5. **Store context for later** — "That meeting with Alice" should be instantly retrievable

**Failure mode to avoid:** Generic notes that require the user to re-interpret later. Structured, purpose-fit notes are immediately actionable.
