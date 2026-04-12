# Email Workflows: Advanced Inbox Management

This guide covers advanced patterns for email triage, clutter learning, and automated follow-up.

## Table of Contents

1. [The 3-Day Chase-Up Rule](#the-3-day-chase-up-rule)
2. [Clutter Learning Patterns](#clutter-learning-patterns)
3. [Self-Sent Reminder Processing](#self-sent-reminder-processing)
4. [Email Prioritization Heuristics](#email-prioritization-heuristics)
5. [Archive vs Delete](#archive-vs-delete)

## The 3-Day Chase-Up Rule

### What It Is

A systematic way to ensure the user doesn't drop commitments made outbound in email.

### Why It Matters

Users often promise to "send that report by Friday" or "follow up next week"—then forget. Outbound commitments are harder to track than inbound requests because they don't sit in the inbox demanding attention.

### How It Works

1. **Daily scan of sent mail:**
   ```bash
   m365-agent-cli mail sent --since "3 days ago" [--mailbox <user_email>]
   ```

2. **Pattern matching:** Look for phrases indicating promises:
   - "I'll send you..."
   - "Let me get back to you on..."
   - "I'll follow up..."
   - "I'll have that to you by..."

3. **Cross-check inbox:** For each outbound commitment, check if a reply arrived:
   ```bash
   m365-agent-cli mail inbox --from <recipient_email> --since <sent_date> [--mailbox <user_email>]
   ```

4. **Flag unresolved threads:**
   - If no reply and 3+ business days have passed, surface to user
   - Offer to draft a follow-up

### Example Flow

**Day 1:** User sends: "Hi Alice, I'll send the budget analysis by Thursday."

**Day 4 (Thursday):** PA scans sent mail, finds the promise, checks inbox for replies from Alice—none found.

**Day 4 outcome:** PA flags the thread and says: "You promised Alice the budget analysis by today. I don't see it in sent items. Would you like me to draft a follow-up or do you need help finishing the analysis?"

### Tuning the Window

- **3 days** is a good default for most business contexts
- Adjust based on user pace: fast-moving startups might use 1-2 days; slower-paced orgs might use 5-7 days
- Store the preference in memory: `chase_up_window_days: 3`

### Reducing False Positives

Not every outbound email creates a commitment. Avoid flagging:
- Transactional emails ("Thanks for your order")
- FYI messages with no ask
- Replies to threads the user isn't driving

**Pattern:** Only chase when the user's message includes a clear deliverable or timeline.

## Clutter Learning Patterns

### Goal

Isolate low-priority mail automatically so the inbox only shows items needing attention.

### What Counts as Clutter

- Newsletters the user never opens
- Marketing emails
- Automated notifications (build systems, monitoring alerts that aren't actionable)
- Social media notifications
- Subscription confirmations
- Event invitations the user always declines

### What Doesn't Count as Clutter

- Email from people the user interacts with regularly
- Email with actionable asks
- Email containing deadlines or commitments
- Thread continuations (even if the original was clutter)

### Learning Process

1. **Observe patterns:** Track which emails the user:
   - Deletes without reading
   - Archives immediately
   - Leaves unread for >7 days

2. **Identify sender patterns:**
   ```bash
   # List senders of unread mail older than 7 days
   m365-agent-cli mail inbox --unread | jq '.[] | select(.receivedDateTime < "<7_days_ago>") | .from.emailAddress'
   ```

3. **Propose filters:** After seeing 3+ ignored emails from the same sender, suggest a filter:
   - "I notice you haven't opened any of the last 5 emails from 'Weekly Digest'. Should I move these to a separate folder going forward?"

4. **Apply filters:**
   ```bash
   m365-agent-cli mail --move <id> --to "Newsletters" [--mailbox <user_email>]
   ```

5. **Create inbox rules (if supported):** Automate the move for future emails from that sender

### Folder Structure

Recommend a simple, three-tier structure:
- **Inbox** — Needs attention
- **Archive** — Handled, may need later
- **Clutter** — Low-priority, batch-review when convenient

Avoid over-organization (15 nested folders defeats the purpose).

### Review Cadence

Suggest the user review "Clutter" weekly or monthly to catch false positives. If they rescue an email from Clutter, remove that sender from the filter.

## Self-Sent Reminder Processing

### Why Users Email Themselves

Quick, ubiquitous, no app switching. The email client is always open, so sending a reminder to oneself is faster than opening a task app.

### How to Handle

1. **Detect self-sent mail:**
   ```bash
   m365-agent-cli mail inbox --from <user_email> [--mailbox <user_email>]
   ```

2. **Parse intent:**
   - Subject contains a deadline or action: `"Book flights for conference"`
   - Body contains a note: `"Remember to review the contract before Monday"`

3. **Surface vs auto-convert:**
   - **Surface in morning briefing:** Include self-sent reminders in the "Inbox priority" section
   - **Auto-convert to task:** If the user has established a pattern (e.g., always moves self-sent reminders to tasks), convert automatically:
     ```bash
     m365-agent-cli todo create --title "<subject>" --due "<inferred_or_asked_date>" [--user <user_email>]
     m365-agent-cli mail --move <id> --to "Archive" [--mailbox <user_email>]
     ```

### Example

**User sends to self:** `Subject: "Call vendor re: contract renewal"`

**PA behavior (morning briefing):**
```
📬 Inbox priority:
1. Self-reminder: "Call vendor re: contract renewal" (sent yesterday)
   → Would you like me to add this to your task list?
```

**If user confirms:** Create task, archive email.

## Email Prioritization Heuristics

Not all email is equally urgent. Prioritize based on:

### High Priority Indicators
- **Sender is the user's manager** (infer from org chart if available, or learn from user behavior)
- **Subject contains:** "urgent", "ASAP", "deadline", "decision needed"
- **Thread the user is actively driving** (user sent the last message)
- **External sender with short reply window** (e.g., customer support ticket)
- **Flagged by user**
- **Mentioned in a meeting** (cross-reference calendar notes)

### Medium Priority
- **Regular work contacts** (people the user emails weekly)
- **Project-related threads** (match subject to active projects in memory)
- **Scheduled emails** (sent via scheduling feature, implies thought went into timing)

### Low Priority
- **No explicit ask**
- **FYI-only** ("For your information")
- **CC'd but not To'd** (user is copied, not primary recipient)
- **Senders the user rarely engages with**

### Flag Automatically (with user approval pattern)

After learning priorities, offer to auto-flag high-priority email:
- "I notice emails from [Manager Name] often need quick responses. Should I auto-flag these going forward?"

## Archive vs Delete

### Archive by Default

Deleting email is risky:
- Hard to undo
- May contain useful context later
- Storage is cheap

**Rule:** Unless the email is spam/phishing, archive it.

### When to Delete

Only delete:
- **Confirmed spam** (unsolicited commercial email)
- **Phishing attempts** (after flagging to user)
- **Duplicates** (exact copies of the same message)

### Archive Process

```bash
# Move handled email to Archive folder
m365-agent-cli mail --move <id> --to "Archive" [--mailbox <user_email>]
```

**Why not just leave it in Inbox?** A cluttered inbox increases cognitive load. "Archive" means "handled, no action needed."

### Establishing the Archive Pattern

Before auto-archiving, establish the pattern with the user:
1. First time: "This thread looks resolved. Should I move it to Archive?"
2. After 3-5 confirmations: "I notice you're archiving all resolved threads. Should I start doing this automatically?"
3. Once approved: Archive silently, mention in summary: "Archived 7 resolved threads."

## Advanced: Thread Continuity

### Problem

User asks about "that email from Alice." Which one? There may be dozens.

### Solution: Thread Context in Memory

When storing email-related facts, include:
- **Thread subject**
- **Key participants**
- **Date range**
- **Core topic**

**Example memory entry:**
```
Fact: Email thread "Q2 Budget Review" with Alice Chen and Bob Martinez, started Apr 1, discussed capital allocation for product expansion. User committed to delivering analysis by Apr 15.
```

**Retrieval:** When user says "that email from Alice," recall threads involving Alice and rank by recency or relevance.

## Advanced: Automated Drafting Patterns

### When to Draft Without Asking

If the user has established a clear pattern (e.g., always replies to certain senders with a specific format), draft automatically and notify.

**Example:** Support tickets always get: "Thanks for reaching out. I'm looking into this and will respond within 24 hours."

**Setup:**
1. Observe pattern (3+ identical responses)
2. Propose automation: "You always send this reply to support tickets. Should I draft these automatically going forward?"
3. If approved, draft and notify: "Drafted reply to support ticket #12345 (in Drafts)."

### When to Ask First

If there's any ambiguity:
- First-time sender
- Topic is sensitive or high-stakes
- Tone needs to match a specific context

**Default:** When in doubt, propose the draft and let the user approve before sending.

## Summary

Email workflows are high-leverage: small automations (chase-ups, clutter filters, self-sent reminders) compound into hours saved weekly.

**Key principles:**
1. **Chase commitments made outbound** — Don't let promises slip
2. **Learn clutter patterns** — Protect inbox signal-to-noise ratio
3. **Surface self-sent reminders** — Treat them as first-class tasks
4. **Prioritize intelligently** — Not all email is equal
5. **Archive liberally, delete conservatively** — Storage is cheap, context is valuable
6. **Build thread context in memory** — Enable fast retrieval later

**Failure mode to avoid:** Over-automating without learning patterns. Always establish user preferences before automating workflows.
