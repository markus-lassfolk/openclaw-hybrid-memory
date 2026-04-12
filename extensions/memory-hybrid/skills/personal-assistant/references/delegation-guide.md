# Delegation Guide: Acting on Behalf of the User

This guide covers the details of operating with a dedicated assistant account that has delegated access to the user's Microsoft 365 resources.

## Table of Contents

1. [Understanding Delegation Models](#understanding-delegation-models)
2. [Protocol Differences: EWS vs Graph API](#protocol-differences)
3. [Troubleshooting Auth Issues](#troubleshooting-auth-issues)
4. [Mailbox Permissions](#mailbox-permissions)
5. [Testing Delegation Setup](#testing-delegation-setup)

## Understanding Delegation Models

### Model 1: Direct Access (Shared Account)
- Claude uses the user's own Microsoft 365 credentials
- No delegation flags needed—all commands target the user's resources by default
- Tone should match the user exactly (you are them)
- Use case: Personal use, small teams, consultants

### Model 2: Dedicated Assistant Account
- Claude has a separate M365 identity (e.g., `assistant@company.com`)
- Requires delegation flags to access the user's mailbox/calendar
- Tone should be transparent ("I'm [User]'s assistant") unless instructed otherwise
- Use case: Enterprise settings, assistants supporting executives, team assistants

## Protocol Differences

Microsoft 365 exposes functionality through multiple APIs. The `m365-agent-cli` tool uses different backends depending on the command, and each has its own delegation mechanism.

### Exchange Web Services (EWS)

**Commands:** `mail`, `calendar`, `drafts`, `send`, `respond`, `findtime`

**Delegation flag:** `--mailbox <user_email>`

**Why:** EWS was designed for client applications (Outlook, etc.) and natively supports "open this mailbox" semantics. The `--mailbox` flag tells EWS to operate on the specified user's mailbox rather than the authenticated account's mailbox.

**Example:**
```bash
# Check the user's inbox (not the assistant's)
m365-agent-cli mail inbox --unread --mailbox user@company.com
```

**Common mistake:** Forgetting `--mailbox` when acting on behalf of the user. The command will succeed but operate on the assistant's own mailbox, leading to "inbox is empty" confusion.

### Microsoft Graph API

**Commands:** `todo`, `planner`, `files`, and potentially others

**Delegation flag:** `--user <user_email>` (for commands that support it)

**Why:** Graph API is Microsoft's modern unified API. Not all Graph endpoints support delegation in the same way. Some require explicit `--user` flags; others infer context from auth tokens.

**Verified delegation support:**
- `todo` commands: `--user <user_email>` works
- `planner`, `files`: Verify per subcommand with `--help`

**Example:**
```bash
# Create a task in the user's To Do list
m365-agent-cli todo create --title "Review budget" --due 2025-05-15 --user user@company.com
```

**Common mistake:** Assuming all Graph commands support `--user` because `todo` does. Always check `--help` for each subcommand.

### Why Flags Aren't Interchangeable

Using `--user` on an EWS command (or `--mailbox` on a Graph command) will either be ignored, cause an error, or target the wrong resource. The protocols are separate stacks with different delegation models.

**Rule:** When in doubt, run `m365-agent-cli <command> --help` and look for delegation flags in the output.

## Troubleshooting Auth Issues

### Symptom: "Access Denied" or "Unauthorized"

**Possible causes:**
1. The assistant account lacks delegated access permissions
2. The user's admin hasn't granted the necessary Graph/EWS permissions
3. Auth token expired and needs refresh

**Diagnosis:**
```bash
# Test basic auth first
m365-agent-cli mail inbox --unread
# Should work for the assistant's own mailbox

# Then test delegation
m365-agent-cli mail inbox --unread --mailbox user@company.com
# If this fails, it's a permissions issue
```

**Resolution:**
- Have the user's admin grant "Full Access" or "Send As" permissions to the assistant account
- For Graph API, ensure the assistant app registration has delegated permissions (e.g., `Mail.ReadWrite.Shared`, `Calendars.ReadWrite.Shared`)
- Re-authenticate: `m365-agent-cli auth login`

### Symptom: "Mailbox not found"

**Possible causes:**
1. Email address is misspelled
2. User account doesn't exist in the tenant
3. Mailbox hasn't been provisioned yet (new account)

**Diagnosis:**
```bash
# Verify the email address
m365-agent-cli users list | grep user@company.com
```

**Resolution:**
- Double-check spelling with the user
- Confirm the account exists in Azure AD / Entra ID
- Wait for mailbox provisioning if it's a new account (can take minutes to hours)

### Symptom: Silent Failures (Command Succeeds but Operates on Wrong Mailbox)

**Possible causes:**
1. Forgot `--mailbox` or `--user` flag
2. Used the wrong flag for the protocol

**Diagnosis:**
- Check which mailbox was actually accessed by verifying the output
- Re-run with explicit delegation flag

**Resolution:**
- Always use delegation flags when acting on behalf of the user
- Create a checklist or script to enforce flag usage

## Mailbox Permissions

The assistant account needs specific permissions to access the user's resources.

### Exchange/EWS Permissions

**Grant "Full Access":**
```powershell
# Run by Exchange admin
Add-MailboxPermission -Identity user@company.com -User assistant@company.com -AccessRights FullAccess -InheritanceType All
```

**Grant "Send As":**
```powershell
Add-RecipientPermission -Identity user@company.com -Trustee assistant@company.com -AccessRights SendAs
```

**Why both:** "Full Access" allows reading mail and calendar; "Send As" allows sending mail on behalf of the user.

### Graph API Permissions

The assistant app registration (in Azure AD) needs application or delegated permissions:

**Recommended delegated permissions:**
- `Mail.ReadWrite.Shared`
- `Calendars.ReadWrite.Shared`
- `Tasks.ReadWrite.Shared`
- `Files.ReadWrite.All` (if collaborating on documents)

**Grant via Azure Portal:**
1. Azure AD → App registrations → [Assistant App]
2. API permissions → Add permission → Microsoft Graph
3. Choose "Delegated permissions"
4. Select the permissions above
5. Click "Grant admin consent"

**Why delegated vs application:** Delegated permissions work in the context of a signed-in user (the assistant), with access scoped to what the user can delegate. Application permissions would grant broader access and aren't appropriate for assistant scenarios.

## Testing Delegation Setup

### Step 1: Test Assistant's Own Mailbox

```bash
# Should work without any delegation setup
m365-agent-cli mail inbox --unread
```

**Expected:** List of unread mail in the assistant's own inbox (may be empty).

**If this fails:** Auth issue with the assistant account itself. Re-authenticate.

### Step 2: Test Delegated Mail Access

```bash
# Should work if Full Access is granted
m365-agent-cli mail inbox --unread --mailbox user@company.com
```

**Expected:** List of unread mail in the user's inbox.

**If this fails:** Delegation permissions not granted or incorrect email address.

### Step 3: Test Delegated Calendar Access

```bash
m365-agent-cli calendar today --mailbox user@company.com
```

**Expected:** Today's meetings from the user's calendar.

**If this fails:** Same as mail access—check permissions.

### Step 4: Test Delegated To Do Access

```bash
m365-agent-cli todo list --user user@company.com
```

**Expected:** List of tasks from the user's To Do.

**If this fails:** Graph API permissions not granted. Check app registration.

### Step 5: Test Send As

```bash
# Create a draft (doesn't send)
m365-agent-cli drafts --create --to test@example.com --subject "Test" --body "Testing send as" --mailbox user@company.com
```

**Expected:** Draft appears in the user's Drafts folder.

**If this fails:** "Send As" permission not granted.

## Best Practices

1. **Always use delegation flags in automated workflows** — Don't rely on defaults or assume context
2. **Test each command individually** — Just because `mail` works doesn't mean `calendar` will
3. **Document which flags work for each command** — Build a reference as you discover edge cases
4. **Keep auth tokens fresh** — Re-authenticate periodically to avoid mid-workflow auth failures
5. **Log delegation flag usage** — When debugging, knowing whether the flag was used is critical

## Common Scenarios

### Scenario: User forwards work to the assistant's email

**Setup:**
- Assistant checks own inbox: `m365-agent-cli mail inbox --unread`
- Identifies forwarded items
- Acts on behalf of user with `--mailbox user@company.com` when needed

**Why:** Keeps forwarded work separate from direct work. The assistant's inbox is the "work queue."

### Scenario: User wants assistant to send on their behalf

**Setup:**
- Draft the email using `--mailbox user@company.com`
- User reviews the draft in their Drafts folder
- User approves, assistant sends using `m365-agent-cli send <draft_id> --mailbox user@company.com`

**Why:** User maintains control over what goes out, but the assistant handles the mechanics.

### Scenario: Multiple users share one assistant

**Setup:**
- Use `--mailbox <user1@company.com>` or `--mailbox <user2@company.com>` depending on context
- Store user preferences in memory with scope tied to each user
- Maintain separate working contexts for each user

**Why:** Prevents cross-contamination of work. The assistant becomes a shared resource with per-user state.

## Summary

Delegation is the mechanism that allows a dedicated assistant account to act on behalf of the user. The key challenges are:

1. **Protocol differences:** EWS vs Graph API require different flags
2. **Permission setup:** Admins must grant explicit access
3. **Command-specific behavior:** Not all commands support delegation the same way

**Golden rule:** When acting on behalf of the user, always verify delegation flags with `<command> --help` before relying on a command in production workflows.
