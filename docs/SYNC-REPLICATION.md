---
layout: default
title: Encrypted sync replication
nav_order: 82
---

# Encrypted sync / replication (optional)

Hybrid Memory remains local-first by default.  
For multi-device continuity, you can use encrypted replication bundles.

## Export encrypted bundle

```bash
export HYBRID_MEM_SYNC_PASSPHRASE='your-strong-passphrase'
openclaw hybrid-mem sync-export --out /tmp/hm-sync-$(date +%Y%m%d).hm-sync
```

Optional source filtering:

```bash
openclaw hybrid-mem sync-export --out /tmp/hm-sync.hm-sync --sources conversation,distill
```

## Import/decrypt bundle

```bash
export HYBRID_MEM_SYNC_PASSPHRASE='your-strong-passphrase'
openclaw hybrid-mem sync-import \
  --in /tmp/hm-sync-20260510.hm-sync \
  --out /tmp/hm-sync-decrypted.json
```

The decrypted JSON payload can then be used in controlled restore/import workflows.

## Security notes

- Uses AES-256-GCM envelope encryption.
- Key derivation: PBKDF2-SHA256 with per-bundle random salt.
- Keep passphrases in environment variables, not shell history.
- Keep bundles in trusted storage only.
