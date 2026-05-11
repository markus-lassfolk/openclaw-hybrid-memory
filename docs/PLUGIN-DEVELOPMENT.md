# Example Plugins for OpenClaw Hybrid Memory

This directory contains example plugins that demonstrate the plugin API capabilities.

## Available Example Plugins

### 1. Slack Notifications (`slack-notifications/`)
Sends Slack notifications when important facts are stored.

**Features:**
- Notifies channel when fact importance > 0.8
- Configurable via environment variable `SLACK_WEBHOOK_URL`
- Filters by category (preferences, decisions)

**Installation:**
```bash
cp -r examples/slack-notifications ~/.openclaw/memory/plugins/
```

### 2. Fact Analytics (`fact-analytics/`)
Tracks and reports on memory usage patterns.

**Features:**
- Counts facts by category
- Tracks daily/weekly/monthly growth
- Exports analytics to JSON/CSV

### 3. Auto-Tagger (`auto-tagger/`)
Automatically adds tags to facts based on content analysis.

**Features:**
- Uses keyword extraction
- Suggests relevant tags
- Learns from user corrections

### 4. Backup Reminder (`backup-reminder/`)
Reminds users to backup their memory data.

**Features:**
- Checks backup frequency
- Sends notifications when backup overdue
- Integrates with cron jobs

## Creating Your Own Plugin

See the [Plugin Development Guide](../docs/PLUGIN-DEVELOPMENT.md) for details.

### Basic Structure

```
my-plugin/
├── package.json
├── index.js (or index.ts)
└── README.md
```

### Minimal Plugin Example

```typescript
import type { MemoryPlugin } from '@openclaw/memory-plugin-api';

export default {
  metadata: {
    id: 'my-plugin',
    name: 'My Plugin',
    version: '1.0.0',
    description: 'Does something cool',
    author: 'Your Name'
  },

  capabilities: {
    canModifyFacts: false,
    canInterceptSearch: false
  },

  hooks: {
    afterFactStore: async (fact) => {
      console.log('New fact stored:', fact);
    }
  },

  async init(context) {
    context.logger.info('Plugin initialized!');
  }
} as MemoryPlugin;
```

## Installing Plugins

### From npm
```bash
hybrid-mem plugin install @openclaw/plugin-slack-notifications --npm
```

### From local directory
```bash
hybrid-mem plugin install ./my-plugin --local
```

### List installed plugins
```bash
hybrid-mem plugin list
```

### Remove a plugin
```bash
hybrid-mem plugin remove my-plugin
```

## Plugin Hooks

Available lifecycle hooks:

- `beforeFactStore(fact)` - Modify fact before storage
- `afterFactStore(fact)` - React to fact storage
- `beforeFactDelete(factId)` - Prevent deletion (return false)
- `afterFactDelete(factId)` - Cleanup after deletion
- `beforeSearch(query)` - Modify search query
- `afterSearch(results)` - Filter/enhance results
- `onMaintenance()` - Run during maintenance cycles
- `onShutdown()` - Cleanup on shutdown

## Plugin Context

Plugins receive a context object with:

- `factsDb` - Access to facts database
- `vectorDb` - Access to vector database (if enabled)
- `config` - Plugin configuration
- `logger` - Logging functions
- `emit(event, data)` - Emit events to other plugins
- `registerEndpoint(path, handler)` - Add API endpoints
- `registerCommand(name, handler)` - Add CLI commands

## Security

Plugins run with full access to the memory system. Only install plugins from trusted sources.

**Best practices:**
- Review plugin code before installation
- Check plugin reputation/downloads
- Keep plugins updated
- Report security issues to authors

## Publishing Your Plugin

1. Create npm package
2. Prefix with `openclaw-memory-plugin-`
3. Add keywords: `openclaw`, `memory`, `plugin`
4. Publish to npm

Example `package.json`:
```json
{
  "name": "openclaw-memory-plugin-my-plugin",
  "version": "1.0.0",
  "description": "My awesome plugin",
  "keywords": ["openclaw", "memory", "plugin"],
  "main": "index.js",
  "peerDependencies": {
    "@openclaw/memory-client": "^1.0.0"
  }
}
```

## Plugin Marketplace

Coming soon: Browse and discover plugins at https://openclaw.dev/plugins
