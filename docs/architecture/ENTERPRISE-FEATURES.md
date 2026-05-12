# Enterprise Architecture Guide

This document outlines the architectural designs for three strategic enterprise features:

1. **Hybrid Memory Cloud** - Hosted multi-tenant memory service
2. **Multi-User Collaboration** - Team-based memory management
3. **Federated Memory** - Privacy-preserving cross-device sync

---

## 1. Hybrid Memory Cloud Architecture

### Overview

A hosted, multi-tenant SaaS offering that provides OpenClaw Hybrid Memory as a managed service.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────┐
│                  Client Applications                 │
│   (OpenClaw Agents, Custom Apps, Mobile, Web)       │
└───────────────────┬─────────────────────────────────┘
                    │
          ┌─────────┴──────────┐
          │                    │
     REST API            GraphQL API
          │                    │
┌─────────┴────────────────────┴──────────┐
│         API Gateway / Load Balancer      │
│              (CloudFlare / AWS ALB)      │
└─────────┬────────────────────────────────┘
          │
┌─────────┴────────────────────────────────┐
│      Application Layer (Node.js)         │
│  ┌────────────────────────────────────┐  │
│  │  Auth & Tenant Isolation Service   │  │
│  ├────────────────────────────────────┤  │
│  │  Memory Service (Core Plugin)      │  │
│  ├────────────────────────────────────┤  │
│  │  Embedding Service (Pooled)        │  │
│  ├────────────────────────────────────┤  │
│  │  Search & Retrieval Service        │  │
│  ├────────────────────────────────────┤  │
│  │  Billing & Usage Tracking          │  │
│  └────────────────────────────────────┘  │
└─────────┬────────────────────────────────┘
          │
   ┌──────┴─────────┐
   │                │
┌──▼──────────┐  ┌──▼────────────┐
│  PostgreSQL │  │  S3/R2        │
│  (Metadata) │  │  (Backups)    │
└─────────────┘  └───────────────┘
   │                │
   │            ┌───▼──────────────┐
   │            │  Per-Tenant DB   │
   │            │  ┌─────────────┐ │
   └────────────┼──┤ SQLite      │ │
                │  ├─────────────┤ │
                │  │ LanceDB     │ │
                │  └─────────────┘ │
                └──────────────────┘
```

### Key Components

#### 1. **Tenant Isolation**

**Database per tenant:**
- Each tenant gets isolated SQLite + LanceDB
- Stored in S3/R2 with lazy loading
- Mounted on-demand when tenant active
- Cached in memory for hot tenants

**Benefits:**
- Complete data isolation
- Easy backup/restore per tenant
- Regulatory compliance (GDPR, SOC2)
- Can be self-hosted easily (export tenant DB)

#### 2. **Authentication & Authorization**

**Auth Service:**
\`\`\`typescript
interface TenantContext {
  tenantId: string;
  userId: string;
  plan: 'free' | 'pro' | 'enterprise';
  limits: {
    maxFacts: number;
    maxEmbeddingsPerDay: number;
    maxAPICallsPerMinute: number;
  };
}
\`\`\`

**API Key Structure:**
\`\`\`
hm_live_<tenantId>_<randomBytes>
hm_test_<tenantId>_<randomBytes>
\`\`\`

#### 3. **Usage Tracking & Billing**

Track per tenant:
- Facts stored
- Embeddings generated
- API calls made
- Storage used
- Bandwidth consumed

**Billing tiers:**

| Tier | Facts | Embeddings/mo | Support | Price |
|------|-------|---------------|---------|-------|
| **Free** | 1,000 | 5,000 | Community | $0 |
| **Pro** | 100,000 | 500,000 | Email | $29/mo |
| **Team** | 1M | 5M | Priority | $99/mo |
| **Enterprise** | Unlimited | Unlimited | Dedicated | Custom |

#### 4. **Embedding Service**

**Pooled embedding generation:**
- Shared embedding workers
- Queue-based processing
- Batch API calls for efficiency
- Caching for duplicate texts

**Cost optimization:**
- Use `text-embedding-3-small` (cheapest)
- Batch up to 2048 texts per API call
- Cache embeddings (99% hit rate expected)
- Rate limit per tenant

#### 5. **Data Backup & Export**

**Automated backups:**
- Daily snapshots to S3/R2
- 30-day retention
- Point-in-time recovery
- Cross-region replication

**Export formats:**
- JSON (full export)
- SQLite file (raw database)
- CSV (for analytics)
- GraphML (for visualization)

### Deployment

**Infrastructure:**
- **Compute:** AWS ECS / Fly.io / Railway
- **Storage:** S3 / Cloudflare R2
- **Metadata:** PostgreSQL (RDS / Neon)
- **CDN:** CloudFlare
- **Monitoring:** Datadog / Grafana Cloud

**Scaling strategy:**
- Horizontal scaling of API servers
- Per-tenant DB sharding
- Read replicas for analytics
- CDN for static assets

### Security

- **Encryption at rest:** AES-256 for all tenant data
- **Encryption in transit:** TLS 1.3 for all API calls
- **Access control:** JWT-based auth with short expiry
- **Audit logging:** All data access logged
- **Compliance:** SOC2, GDPR, HIPAA-ready

### Migration Path

**From self-hosted to cloud:**
1. Export local database
2. Create cloud account
3. Import via API or UI
4. Update API endpoint in config
5. Verify data migrated
6. Delete local copy (optional)

**From cloud to self-hosted:**
1. Download tenant database
2. Install OpenClaw locally
3. Import database file
4. Configure local embedding provider
5. Run locally

---

## 2. Multi-User Collaboration Architecture

### Overview

Enable teams to share memory spaces, collaborate on facts, and maintain knowledge bases together.

### Architecture

```
┌──────────────────────────────────────┐
│          Organization                │
│  ┌────────────────────────────────┐  │
│  │  Shared Memory Spaces          │  │
│  │  ┌──────────┐  ┌──────────┐   │  │
│  │  │ Project A│  │ Project B│   │  │
│  │  └──────────┘  └──────────┘   │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  Team Members                  │  │
│  │  ┌──────┐ ┌──────┐ ┌──────┐   │  │
│  │  │Alice │ │ Bob  │ │Carol │   │  │
│  │  │Admin │ │Write │ │Read  │   │  │
│  │  └──────┘ └──────┘ └──────┘   │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

### Data Model

\`\`\`typescript
interface Organization {
  id: string;
  name: string;
  createdAt: number;
  plan: 'team' | 'enterprise';
}

interface MemorySpace {
  id: string;
  orgId: string;
  name: string;
  description: string;
  visibility: 'private' | 'org' | 'public';
  createdBy: string;
  createdAt: number;
}

interface Member {
  userId: string;
  orgId: string;
  role: 'admin' | 'editor' | 'viewer';
  joinedAt: number;
}

interface Permission {
  userId: string;
  spaceId: string;
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  canManage: boolean;
}

interface Fact {
  // ... existing fields ...
  orgId?: string;
  spaceId?: string;
  createdBy: string;
  lastEditedBy?: string;
  sharedWith?: string[]; // User IDs with access
}
\`\`\`

### Permission System

**Roles:**

| Role | Read | Write | Delete | Manage Members | Manage Spaces |
|------|------|-------|--------|---------------|---------------|
| **Admin** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Editor** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Viewer** | ✅ | ❌ | ❌ | ❌ | ❌ |

**Space-level permissions** can override org-level roles.

### Collaboration Features

#### 1. **Shared Memory Spaces**

Create spaces for different contexts:
- **Projects:** "Website Redesign", "Q4 Campaign"
- **Customers:** "Acme Corp Support", "TechCo Integration"
- **Topics:** "Python Best Practices", "Design System"

#### 2. **Fact Suggestions**

Team members can suggest edits:
\`\`\`typescript
interface FactSuggestion {
  id: string;
  factId: string;
  suggestedBy: string;
  suggestionType: 'edit' | 'delete' | 'supersede';
  newText?: string;
  reason?: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewedBy?: string;
  reviewedAt?: number;
}
\`\`\`

#### 3. **Comments & Annotations**

Discuss facts:
\`\`\`typescript
interface FactComment {
  id: string;
  factId: string;
  authorId: string;
  text: string;
  createdAt: number;
  resolved: boolean;
}
\`\`\`

#### 4. **Activity Feed**

Track all changes:
\`\`\`typescript
interface Activity {
  id: string;
  orgId: string;
  spaceId?: string;
  actorId: string;
  action: 'created' | 'updated' | 'deleted' | 'commented';
  targetType: 'fact' | 'space' | 'member';
  targetId: string;
  timestamp: number;
  metadata: Record<string, unknown>;
}
\`\`\`

#### 5. **Conflict Resolution**

When multiple users edit:
1. Last-write-wins for non-conflicting edits
2. Merge suggestions for conflicting edits
3. Admin approval for deletions
4. Version history preserved

### Use Cases

**Customer Support Team:**
- Shared space: "Customer Knowledge Base"
- Each agent sees: company facts + customer history
- Collaborative fact curation
- Quality review by team leads

**Engineering Team:**
- Spaces per project: "Frontend", "Backend", "DevOps"
- Shared: Architecture decisions, coding standards
- Private: Individual notes, experiments
- Cross-project search

**Research Team:**
- Spaces per research topic
- Collaborative literature review
- Shared findings and insights
- Publication-ready exports

### Implementation Phases

**Phase 1: Foundation**
- Organization & member management
- Basic permission system
- Space creation & assignment

**Phase 2: Collaboration**
- Fact suggestions & approvals
- Comments & annotations
- Activity feeds

**Phase 3: Advanced**
- Conflict resolution
- Advanced permissions (field-level)
- Analytics & insights
- Integrations (Slack, Teams)

---

## 3. Federated Memory Architecture

### Overview

Privacy-preserving memory sync across devices without centralized storage.

### Design Principles

1. **E2E Encryption:** All data encrypted client-side
2. **Zero-Knowledge:** Server never sees plaintext
3. **Selective Sharing:** User controls what's shared
4. **Federated Learning:** Aggregate insights without raw data

### Architecture

```
┌──────────────┐          ┌──────────────┐
│   Device A   │          │   Device B   │
│   (Laptop)   │          │   (Phone)    │
│              │          │              │
│  ┌────────┐  │          │  ┌────────┐  │
│  │ Facts  │  │   Sync   │  │ Facts  │  │
│  │ Store  │◄─┼──────────┼─►│ Store  │  │
│  └────────┘  │          │  └────────┘  │
│      │       │          │      │       │
│      │       │          │      │       │
│  ┌───▼────┐  │          │  ┌───▼────┐  │
│  │Encrypt │  │          │  │Decrypt │  │
│  └───┬────┘  │          │  └───▲────┘  │
└──────┼───────┘          └──────┼───────┘
       │                         │
       │     ┌─────────────┐     │
       └────►│  Sync Server│◄────┘
             │ (Blind Relay)│
             └──────┬──────┘
                    │
          ┌─────────▼────────┐
          │ Encrypted Blobs  │
          │ (S3 / IPFS)      │
          └──────────────────┘
```

### Key Components

#### 1. **Client-Side Encryption**

\`\`\`typescript
interface EncryptedFact {
  id: string; // HMAC of content
  ciphertext: string; // AES-GCM encrypted fact
  nonce: string;
  deviceId: string;
  timestamp: number;
  hmac: string; // Verify integrity
}
\`\`\`

**Encryption flow:**
1. Generate device key pair (ECDH)
2. Derive shared secret with other devices
3. Encrypt fact with AES-256-GCM
4. Upload encrypted blob
5. Other devices decrypt with shared secret

#### 2. **Sync Protocol**

**Delta sync:**
\`\`\`typescript
interface SyncRequest {
  deviceId: string;
  lastSyncTimestamp: number;
  hmacSignature: string;
}

interface SyncResponse {
  newFacts: EncryptedFact[];
  updatedFacts: EncryptedFact[];
  deletedFactIds: string[];
  nextSyncTimestamp: number;
}
\`\`\`

**Conflict resolution:**
- Last-write-wins for same fact ID
- Vector clocks for causality
- CRDT for concurrent edits

#### 3. **Selective Sharing**

Share specific facts with others:
\`\`\`typescript
interface SharedFact {
  factId: string;
  sharedWith: string[]; // Public keys
  encryptedKeys: Record<string, string>; // Per-recipient
  permissions: ('read' | 'write')[];
}
\`\`\`

**Sharing flow:**
1. Alice encrypts fact with symmetric key K
2. Encrypts K with Bob's public key
3. Uploads encrypted fact + encrypted key
4. Bob decrypts K with his private key
5. Bob decrypts fact with K

#### 4. **Zero-Knowledge Proofs**

Prove fact existence without revealing content:
\`\`\`typescript
interface FactProof {
  factId: string;
  proof: string; // ZK-SNARK proof
  publicInputs: {
    category: string; // Category is public
    timestamp: number;
    importance: number;
  };
}
\`\`\`

**Use case:** Prove "I have a fact about X" without revealing X.

#### 5. **Federated Analytics**

Aggregate insights across users without collecting raw data:
\`\`\`typescript
interface FederatedInsight {
  metric: string;
  aggregateValue: number;
  epsilon: number; // Differential privacy budget
  participants: number;
}
\`\`\`

**Example:** "Average facts per user" computed locally, aggregated with noise.

### Security Properties

✅ **Server cannot:**
- Read fact contents
- Know what categories exist
- Correlate facts between users
- Identify fact patterns

✅ **Users can:**
- Sync across devices seamlessly
- Share specific facts securely
- Verify data integrity
- Export & delete all data

### Implementation Technologies

- **Encryption:** `libsodium` / `@noble/ciphers`
- **Key Management:** `@metamask/eth-sig-util`
- **ZK Proofs:** `snarkjs` / `circom`
- **CRDT:** `Yjs` / `automerge`
- **Transport:** WebSocket + TLS 1.3

### Regulatory Compliance

- **GDPR:** User owns encryption keys = data controller
- **CCPA:** No selling data (server can't read it)
- **HIPAA:** E2E encryption meets requirements
- **COPPA:** No data collection (even encrypted)

### Trade-offs

**Pros:**
- Maximum privacy
- No vendor lock-in
- Offline-first
- Censorship-resistant

**Cons:**
- Complex key management
- Sync conflicts harder to resolve
- No server-side search
- Higher client CPU usage

---

## Implementation Roadmap

### Phase 1: Hybrid Memory Cloud (6 months)
- **Month 1-2:** Multi-tenant architecture
- **Month 3-4:** Billing & usage tracking
- **Month 5:** Beta launch (free tier)
- **Month 6:** General availability

### Phase 2: Multi-User Collaboration (4 months)
- **Month 1-2:** Organizations & permissions
- **Month 3:** Shared spaces & suggestions
- **Month 4:** Activity feeds & analytics

### Phase 3: Federated Memory (6 months)
- **Month 1-2:** E2E encryption MVP
- **Month 3-4:** Sync protocol
- **Month 5:** Selective sharing
- **Month 6:** ZK proofs & federated analytics

**Total:** 16 months for all three features

---

## Summary

These three enterprise features position OpenClaw Hybrid Memory as:

1. **Cloud:** Accessible to non-technical users, recurring revenue
2. **Collaboration:** Enterprise-ready, team workflows
3. **Federated:** Privacy-first, cutting-edge cryptography

Each feature appeals to different market segments and can be developed independently.

**Recommendation:** Start with **Hybrid Memory Cloud** for fastest ROI, then add **Collaboration** for enterprise segment, and finally **Federated** for privacy-conscious users.
