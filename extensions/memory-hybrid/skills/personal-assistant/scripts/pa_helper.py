#!/usr/bin/env python3
"""
PA Helper: Common Personal Assistant operations for m365-agent-cli

This script provides helper functions for common PA workflows to avoid
repetitive command construction and reduce errors.
"""

import subprocess
import json
import sys
from datetime import datetime, timedelta
from typing import List, Dict, Optional, Union

class M365Helper:
    """Helper class for m365-agent-cli operations"""

    def __init__(self, mailbox: Optional[str] = None, user: Optional[str] = None):
        """
        Initialize helper with delegation context.

        Args:
            mailbox: Email address for EWS delegation (--mailbox flag)
            user: Email address for Graph API delegation (--user flag)
        """
        self.mailbox = mailbox
        self.user = user

    def _run_command(self, args: List[str], capture_json: bool = True, timeout: int = 30) -> Union[Dict, List]:
        """Run ``m365-agent-cli`` command and return the parsed result.

        Args:
            args: List of CLI arguments (excluding the executable itself).
            capture_json: When ``True``, the helper will request JSON output from the CLI
                (``--output json``) and return the decoded response. When ``False``, the raw
                ``stdout``/``stderr`` text is returned.
            timeout: Maximum number of seconds to allow the subprocess to run. This prevents
                the PA from hanging indefinitely if the CLI blocks for authentication or
                network issues.
        Returns:
            A ``dict`` or ``list`` on success (the decoded JSON response), or a ``dict``
            with an ``"error"`` key on failure. For non‑JSON captures the payload always
            contains at least ``stdout`` and ``stderr`` keys.
        """
        full_cmd = ['m365-agent-cli', *args]

        if capture_json:
            # Request JSON output so we can parse it deterministically.
            full_cmd.extend(['--output', 'json'])

        try:
            result = subprocess.run(
                full_cmd,
                capture_output=True,
                text=True,
                check=True,
                timeout=timeout,
            )

            if capture_json:
                try:
                    return json.loads(result.stdout)
                except json.JSONDecodeError as e:
                    # Surface the raw output so the caller can decide how to proceed.
                    return {
                        "error": f"JSON parse error: {e}",
                        "raw": result.stdout,
                        "cmd": " ".join(full_cmd),
                    }
            # Not capturing JSON – return raw streams for logging/diagnostics.
            return {"stdout": result.stdout, "stderr": result.stderr}

        except subprocess.TimeoutExpired as e:
            return {
                "error": f"Command timed out after {timeout}s",
                "stdout": e.stdout,
                "stderr": e.stderr,
                "cmd": " ".join(full_cmd),
            }
        except subprocess.CalledProcessError as e:
            return {
                "error": str(e),
                "stdout": e.stdout,
                "stderr": e.stderr,
                "cmd": " ".join(full_cmd),
            }

    def _extract_items(self, result: Union[Dict, List]) -> List[Dict]:
        """Normalize CLI response, handling both dict and list shapes plus error payloads."""
        if isinstance(result, dict):
            if "error" in result:
                print(f"PA helper warning: {result['error']}", file=sys.stderr)
                return []
            return result.get("value", [])
        if isinstance(result, list):
            return result
        return []

    def get_unread_mail(self, limit: int = 50) -> List[Dict]:
        """Get unread emails from inbox"""
        args = ['mail', 'inbox', '--unread', '--limit', str(limit)]
        if self.mailbox:
            args.extend(['--mailbox', self.mailbox])

        result = self._run_command(args)
        return self._extract_items(result)

    def get_sent_mail_since(self, days_ago: int = 3, limit: int = 100) -> List[Dict]:
        """Get sent mail from the last N days for chase-up scanning"""
        since_date = (datetime.now() - timedelta(days=days_ago)).strftime('%Y-%m-%d')
        args = ['mail', 'sent', '--since', since_date, '--limit', str(limit)]
        if self.mailbox:
            args.extend(['--mailbox', self.mailbox])

        result = self._run_command(args)
        return self._extract_items(result)

    def get_todays_calendar(self) -> List[Dict]:
        """Get today's calendar events"""
        args = ['calendar', 'today']
        if self.mailbox:
            args.extend(['--mailbox', self.mailbox])

        result = self._run_command(args)
        return self._extract_items(result)

    def flag_email(self, email_id: str) -> Dict:
        """Flag an email for follow-up"""
        args = ['mail', '--flag', email_id]
        if self.mailbox:
            args.extend(['--mailbox', self.mailbox])

        return self._run_command(args, capture_json=False)

    def move_email(self, email_id: str, folder: str) -> Dict:
        """Move email to a folder (e.g., Archive, Clutter, Suspicious)"""
        args = ['mail', '--move', email_id, '--to', folder]
        if self.mailbox:
            args.extend(['--mailbox', self.mailbox])

        return self._run_command(args, capture_json=False)

    def create_draft(self, to: str, subject: str, body: str) -> Dict:
        """Create an email draft"""
        args = [
            'drafts', '--create',
            '--to', to,
            '--subject', subject,
            '--body', body
        ]
        if self.mailbox:
            args.extend(['--mailbox', self.mailbox])

        return self._run_command(args)

    def create_todo(self, title: str, due_date: Optional[str] = None) -> Dict:
        """
        Create a To Do task.

        Args:
            title: Task title
            due_date: Due date in YYYY-MM-DD format (optional)
        """
        args = ['todo', 'create', '--title', title]
        if due_date:
            args.extend(['--due', due_date])
        if self.user:
            args.extend(['--user', self.user])

        return self._run_command(args)

    def find_commitments_in_sent(self, days_ago: int = 3) -> List[Dict]:
        """
        Scan sent mail for commitment phrases (3-day chase-up rule).

        Returns emails containing commitment language.
        """
        sent_mail = self.get_sent_mail_since(days_ago)

        commitment_phrases = [
            "I'll send",
            "I will send",
            "I'll get back to you",
            "I'll follow up",
            "I'll have that to you",
            "Let me send",
            "I'll share",
            "I'll provide",
            "by end of day",
            "by tomorrow",
            "by friday",
            "by next week"
        ]

        commitments = []
        for email in sent_mail:
            # Skip auto-replied messages (Out of Office, auto-generated)
            headers = email.get('internetMessageHeaders', []) or []
            header_map = {h.get('name', '').lower(): h.get('value', '').lower() for h in headers}
            if header_map.get('auto-submitted') == 'auto-generated' or 'oof' in header_map.get('x-auto-response-suppress', ''):
                continue

            body_raw = email.get('body')
            if isinstance(body_raw, dict):
                body_text = body_raw.get('content', '')
            elif isinstance(body_raw, str):
                body_text = body_raw
            else:
                body_text = ''
            body = body_text.lower()

            subject = str(email.get('subject') or '').lower()

            for phrase in commitment_phrases:
                if phrase.lower() in body or phrase.lower() in subject:
                    commitments.append({
                        'email': email,
                        'matched_phrase': phrase,
                        'sent_date': email.get('sentDateTime'),
                        'recipients': [r.get('emailAddress', {}).get('address')
                                     for r in email.get('toRecipients', [])
                                     if r.get('emailAddress', {}).get('address')]
                    })
                    break  # Only match once per email

        return commitments

    def detect_phishing_indicators(self, email: Dict) -> List[str]:
        """
        Detect phishing red flags in an email.

        Returns list of detected red flags.
        """
        red_flags = []

        # Extract email fields — use str() guard so None subject doesn't crash .lower()
        subject = str(email.get('subject') or '').lower()
        body_raw = email.get('body')
        if isinstance(body_raw, dict):
            body = (body_raw.get('content') or '').lower()
        elif isinstance(body_raw, str):
            body = body_raw.lower()
        else:
            body = ''
        from_address = str(email.get('from', {}).get('emailAddress', {}).get('address') or '').lower()
        from_name = str(email.get('from', {}).get('emailAddress', {}).get('name') or '').lower()

        # 1. Urgency language
        urgency_keywords = ['urgent', 'immediate', 'asap', 'within 24 hours',
                           'account suspension', 'verify immediately', 'act now']
        if any(keyword in subject or keyword in body for keyword in urgency_keywords):
            red_flags.append("Urgency manipulation detected")

        # 2. Threat language
        threat_keywords = ['account will be', 'suspended', 'terminated', 'closed',
                          'locked out', 'unauthorized access']
        if any(keyword in subject or keyword in body for keyword in threat_keywords):
            red_flags.append("Threat of consequences detected")

        # 3. Verification requests (scoped to phishing-specific phrasing to reduce false positives)
        phishing_verify_phrases = [
            'verify your account', 'verify your identity', 'verify your credentials',
            'verify your password', 'verify your information', 'verify your payment',
            'verify your banking', 'confirm your account', 'confirm your identity'
        ]
        if any(phrase in body or phrase in subject for phrase in phishing_verify_phrases):
            red_flags.append("Verification request (common phishing tactic)")

        # 4. Suspicious sender mismatch (basic check)
        # Note: More sophisticated checks would require knowing the organization's domains
        if from_name and from_address:
            if 'support' in from_name and 'support' not in from_address:
                red_flags.append("Sender name/address mismatch")

        return red_flags

    def get_morning_briefing_data(self) -> Dict:
        """
        Gather all data needed for a morning briefing.

        Returns dict with calendar, unread mail, and flagged items.
        """
        return {
            'calendar': self.get_todays_calendar(),
            'unread': self.get_unread_mail(limit=20),
            'timestamp': datetime.now().isoformat()
        }


def main():
    """CLI interface for helper script"""
    import argparse

    parser = argparse.ArgumentParser(description='PA Helper for m365-agent-cli')
    parser.add_argument('--mailbox', help='User email for EWS delegation')
    parser.add_argument('--user', help='User email for Graph delegation')

    subparsers = parser.add_subparsers(dest='command', help='Command to run')

    # Unread mail
    subparsers.add_parser('unread', help='Get unread mail')

    # Chase-up scan
    chase_parser = subparsers.add_parser('chase-up', help='Scan for commitments needing follow-up')
    chase_parser.add_argument('--days', type=int, default=3, help='Days to look back')

    # Today's calendar
    subparsers.add_parser('calendar', help="Get today's calendar")

    # Morning briefing
    subparsers.add_parser('briefing', help='Get morning briefing data')

    # Phishing scan
    subparsers.add_parser('phishing-scan', help='Scan unread mail for phishing indicators')

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    helper = M365Helper(mailbox=args.mailbox, user=args.user)

    if args.command == 'unread':
        emails = helper.get_unread_mail()
        print(json.dumps(emails, indent=2))

    elif args.command == 'chase-up':
        commitments = helper.find_commitments_in_sent(args.days)
        print(f"Found {len(commitments)} emails with commitment language:")
        for c in commitments:
            print(f"\n- Sent: {c['sent_date']}")
            print(f"  To: {', '.join(c['recipients'])}")
            print(f"  Matched: '{c['matched_phrase']}'")
            print(f"  Subject: {c['email'].get('subject')}")

    elif args.command == 'calendar':
        events = helper.get_todays_calendar()
        print(json.dumps(events, indent=2))

    elif args.command == 'briefing':
        data = helper.get_morning_briefing_data()
        print(json.dumps(data, indent=2))

    elif args.command == 'phishing-scan':
        emails = helper.get_unread_mail()
        for email in emails:
            red_flags = helper.detect_phishing_indicators(email)
            if red_flags:
                print(f"\n🚨 Suspicious email detected:")
                print(f"From: {email.get('from', {}).get('emailAddress', {}).get('name')}")
                print(f"Subject: {email.get('subject')}")
                print(f"Red flags: {', '.join(red_flags)}")


if __name__ == '__main__':
    main()
