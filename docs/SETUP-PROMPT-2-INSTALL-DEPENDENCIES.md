# Prompt 2: Install Dependencies

Paste this into your AI assistant:

```
I just created the memory-hybrid plugin files for OpenClaw. Now I need to
install the npm dependencies.

Windows:

  cd "$env:APPDATA\npm\node_modules\openclaw\extensions\memory-hybrid"
  npm install

  cd "$env:USERPROFILE\.openclaw"
  npm install better-sqlite3

Linux:

  cd /usr/lib/node_modules/openclaw/extensions/memory-hybrid
  npm install

  cd ~/.openclaw
  npm install better-sqlite3

If better-sqlite3 fails to compile, install the C++ build toolchain first:
- Windows: Visual Studio Build Tools 2022, "Desktop development with C++"
- Linux: sudo apt install build-essential python3

After installing, verify there are no errors in the npm output.
```
