# Quick Command Reference

Concise lookup table for the most frequently used `m365-agent-cli` workflows. Run `m365-agent-cli <command> --help` for full options and flag details.

| Workflow | Command | Protocol | Delegation flag |
|---|---|---|---|
| Scan unread mail | `m365-agent-cli mail inbox --unread [--mailbox <email>]` | EWS | `--mailbox` |
| Flag an email | `m365-agent-cli mail --flag <id> [--mailbox <email>]` | EWS | `--mailbox` |
| Create a draft | `m365-agent-cli drafts --create --to <to> --subject <subj> --body <body> [--mailbox <email>]` | EWS | `--mailbox` |
| Reply as draft | `m365-agent-cli mail --reply <id> --draft [--mailbox <email>]` | EWS | `--mailbox` |
| Move / archive email | `m365-agent-cli mail --move <id> --to <folder> [--mailbox <email>]` | EWS | `--mailbox` |
| Today's calendar | `m365-agent-cli calendar today [--mailbox <email>]` | EWS | `--mailbox` |
| Week's calendar | `m365-agent-cli calendar week [--mailbox <email>]` | EWS | `--mailbox` |
| Find meeting time | `m365-agent-cli findtime [--user <email>]` | Graph | `--user` |
| Create a To Do task | `m365-agent-cli todo create --title <title> --due <date> [--user <email>]` | Graph | `--user` |
| Create a Planner task | `m365-agent-cli planner create-task --plan <plan> --bucket <bucket> --title <title> [--user <email>]` | Graph | `--user` |
| Download a file | `m365-agent-cli files download <fileId> --out <local_path>` | Graph | — |
| Upload a file | `m365-agent-cli files upload <local_path> [--folder <folder_id>]` | Graph | — |
| List sent mail | `m365-agent-cli mail sent [--mailbox <email>]` | EWS | `--mailbox` |

## Flag cheatsheet

| Protocol | Commands | Correct flag |
|---|---|---|
| EWS (Exchange Web Services) | `mail`, `calendar`, `drafts`, `send`, `respond` | `--mailbox <user_email>` |
| Graph API | `todo`, `planner`, `files`, `findtime` | `--user <user_email>` |

These flags are not interchangeable. Using the wrong one silently targets the wrong account or errors out.
