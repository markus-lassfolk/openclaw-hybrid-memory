# Prompt 3: Configure and Start

Paste this into your AI assistant:

```
The memory-hybrid plugin files and dependencies are installed. Now configure
OpenClaw to use it.

Open openclaw.json:
- Windows: %USERPROFILE%\.openclaw\openclaw.json
- Linux: ~/.openclaw/openclaw.json

Make these changes:

1. Under plugins.slots, set: "memory": "memory-hybrid"

2. Add the plugin entry under plugins.entries:

   "memory-hybrid": {
     "enabled": true,
     "config": {
       "embedding": {
         "apiKey": "${OPENAI_API_KEY}",
         "model": "text-embedding-3-small"
       },
       "autoCapture": true,
       "autoRecall": true
     }
   }

3. Set the OPENAI_API_KEY environment variable:
   - Windows:
     [Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "sk-proj-YOUR-KEY", "User")
   - Linux:
     Add export OPENAI_API_KEY="sk-proj-YOUR-KEY" to ~/.bashrc

4. If a previous memory plugin exists in plugins.entries, leave it — OpenClaw
   will show a harmless warning that it's disabled.

5. Save the config as UTF-8 without BOM.

Then restart OpenClaw:

  openclaw gateway start

Check the logs for "memory-hybrid: initialized" to confirm it loaded, then run:

  openclaw hybrid-mem stats

It should show 0 facts in SQLite and 0 vectors in LanceDB. The databases
will auto-populate as you have conversations.
```
