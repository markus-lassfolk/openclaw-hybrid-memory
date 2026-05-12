/**
 * Multi-User Collaboration System
 * Provides team-based memory management with permissions and shared spaces
 */

import { createRequire } from "node:module";
import type { FactsDB } from "../backends/facts-db.js";

const require = createRequire(import.meta.url);

export interface Organization {
  id: string;
  name: string;
  createdAt: number;
  plan: "free" | "team" | "enterprise";
  settings?: {
    allowPublicSpaces?: boolean;
    requireApproval?: boolean;
    maxMembers?: number;
  };
}

export interface MemorySpace {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  visibility: "private" | "org" | "public";
  createdBy: string;
  createdAt: number;
  settings?: {
    autoCapture?: boolean;
    requireReview?: boolean;
  };
}

export interface Member {
  userId: string;
  orgId: string;
  role: "owner" | "admin" | "editor" | "viewer";
  joinedAt: number;
  invitedBy?: string;
}

export interface SpacePermission {
  userId: string;
  spaceId: string;
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  canManage: boolean;
  grantedAt: number;
  grantedBy: string;
}

export interface FactSuggestion {
  id: string;
  factId?: string; // undefined for new facts
  spaceId: string;
  suggestedBy: string;
  suggestionType: "create" | "edit" | "delete" | "supersede";
  newText?: string;
  newMetadata?: Record<string, unknown>;
  reason?: string;
  status: "pending" | "approved" | "rejected";
  reviewedBy?: string;
  reviewedAt?: number;
  createdAt: number;
}

export interface FactComment {
  id: string;
  factId: string;
  authorId: string;
  text: string;
  createdAt: number;
  updatedAt?: number;
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: number;
}

export interface Activity {
  id: string;
  orgId: string;
  spaceId?: string;
  actorId: string;
  action: "created" | "updated" | "deleted" | "commented" | "reviewed";
  targetType: "fact" | "space" | "member" | "suggestion";
  targetId: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Collaboration Service
 * Manages organizations, spaces, permissions, and team workflows
 */
export class CollaborationService {
  private db: { exec(sql: string): void; prepare(sql: string): any; close?(): void };

  constructor(private sqlitePath: string) {
    this.db = new (require("node:sqlite").DatabaseSync)(sqlitePath);
    this.initSchema();
  }

  /**
   * Initialize collaboration database schema
   */
  private initSchema(): void {
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS organizations (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				plan TEXT NOT NULL DEFAULT 'free',
				settings TEXT
			);

			CREATE TABLE IF NOT EXISTS memory_spaces (
				id TEXT PRIMARY KEY,
				org_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT,
				visibility TEXT NOT NULL DEFAULT 'org',
				created_by TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				settings TEXT,
				FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
			);

			CREATE TABLE IF NOT EXISTS members (
				user_id TEXT NOT NULL,
				org_id TEXT NOT NULL,
				role TEXT NOT NULL DEFAULT 'viewer',
				joined_at INTEGER NOT NULL,
				invited_by TEXT,
				PRIMARY KEY (user_id, org_id),
				FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
			);

			CREATE TABLE IF NOT EXISTS space_permissions (
				user_id TEXT NOT NULL,
				space_id TEXT NOT NULL,
				can_read INTEGER NOT NULL DEFAULT 1,
				can_write INTEGER NOT NULL DEFAULT 0,
				can_delete INTEGER NOT NULL DEFAULT 0,
				can_manage INTEGER NOT NULL DEFAULT 0,
				granted_at INTEGER NOT NULL,
				granted_by TEXT NOT NULL,
				PRIMARY KEY (user_id, space_id),
				FOREIGN KEY (space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE
			);

			CREATE TABLE IF NOT EXISTS fact_suggestions (
				id TEXT PRIMARY KEY,
				fact_id TEXT,
				space_id TEXT NOT NULL,
				suggested_by TEXT NOT NULL,
				suggestion_type TEXT NOT NULL,
				new_text TEXT,
				new_metadata TEXT,
				reason TEXT,
				status TEXT NOT NULL DEFAULT 'pending',
				reviewed_by TEXT,
				reviewed_at INTEGER,
				created_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE
			);

			CREATE TABLE IF NOT EXISTS fact_comments (
				id TEXT PRIMARY KEY,
				fact_id TEXT NOT NULL,
				author_id TEXT NOT NULL,
				text TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER,
				resolved INTEGER NOT NULL DEFAULT 0,
				resolved_by TEXT,
				resolved_at INTEGER
			);

			CREATE TABLE IF NOT EXISTS activities (
				id TEXT PRIMARY KEY,
				org_id TEXT NOT NULL,
				space_id TEXT,
				actor_id TEXT NOT NULL,
				action TEXT NOT NULL,
				target_type TEXT NOT NULL,
				target_id TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				metadata TEXT,
				FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
			);

			-- Indexes for performance
			CREATE INDEX IF NOT EXISTS idx_spaces_org ON memory_spaces(org_id);
			CREATE INDEX IF NOT EXISTS idx_members_org ON members(org_id);
			CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);
			CREATE INDEX IF NOT EXISTS idx_permissions_space ON space_permissions(space_id);
			CREATE INDEX IF NOT EXISTS idx_permissions_user ON space_permissions(user_id);
			CREATE INDEX IF NOT EXISTS idx_suggestions_space ON fact_suggestions(space_id);
			CREATE INDEX IF NOT EXISTS idx_suggestions_status ON fact_suggestions(status);
			CREATE INDEX IF NOT EXISTS idx_comments_fact ON fact_comments(fact_id);
			CREATE INDEX IF NOT EXISTS idx_activities_org ON activities(org_id);
			CREATE INDEX IF NOT EXISTS idx_activities_space ON activities(space_id);
			CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON activities(timestamp DESC);
		`);
  }

  /**
   * Create a new organization
   */
  createOrganization(org: Organization): void {
    const stmt = this.db.prepare(`
			INSERT INTO organizations (id, name, created_at, plan, settings)
			VALUES (?, ?, ?, ?, ?)
		`);
    stmt.run(org.id, org.name, org.createdAt, org.plan, JSON.stringify(org.settings || {}));
  }

  /**
   * Get organization by ID
   */
  getOrganization(orgId: string): Organization | null {
    const stmt = this.db.prepare(`
			SELECT * FROM organizations WHERE id = ?
		`);
    const row = stmt.get(orgId) as
      | { id: string; name: string; created_at: number; plan: string; settings: string }
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      plan: row.plan as Organization["plan"],
      settings: JSON.parse(row.settings || "{}"),
    };
  }

  /**
   * Create a memory space
   */
  createSpace(space: MemorySpace): void {
    const stmt = this.db.prepare(`
			INSERT INTO memory_spaces (id, org_id, name, description, visibility, created_by, created_at, settings)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);
    stmt.run(
      space.id,
      space.orgId,
      space.name,
      space.description || null,
      space.visibility,
      space.createdBy,
      space.createdAt,
      JSON.stringify(space.settings || {}),
    );

    // Log activity
    this.logActivity({
      id: crypto.randomUUID(),
      orgId: space.orgId,
      spaceId: space.id,
      actorId: space.createdBy,
      action: "created",
      targetType: "space",
      targetId: space.id,
      timestamp: Date.now(),
    });
  }

  /**
   * Get spaces for organization
   */
  getSpacesForOrg(orgId: string): MemorySpace[] {
    const stmt = this.db.prepare(`
			SELECT * FROM memory_spaces WHERE org_id = ? ORDER BY created_at DESC
		`);
    const rows = stmt.all(orgId) as Array<{
      id: string;
      org_id: string;
      name: string;
      description: string | null;
      visibility: string;
      created_by: string;
      created_at: number;
      settings: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      description: row.description || undefined,
      visibility: row.visibility as MemorySpace["visibility"],
      createdBy: row.created_by,
      createdAt: row.created_at,
      settings: JSON.parse(row.settings || "{}"),
    }));
  }

  /**
   * Add member to organization
   */
  addMember(member: Member): void {
    const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO members (user_id, org_id, role, joined_at, invited_by)
			VALUES (?, ?, ?, ?, ?)
		`);
    stmt.run(member.userId, member.orgId, member.role, member.joinedAt, member.invitedBy || null);

    // Log activity
    this.logActivity({
      id: crypto.randomUUID(),
      orgId: member.orgId,
      actorId: member.invitedBy || member.userId,
      action: "created",
      targetType: "member",
      targetId: member.userId,
      timestamp: Date.now(),
    });
  }

  /**
   * Check if user has permission for an action
   */
  hasPermission(userId: string, spaceId: string, permission: "read" | "write" | "delete" | "manage"): boolean {
    // Check space permission
    const stmt = this.db.prepare(`
			SELECT can_read, can_write, can_delete, can_manage
			FROM space_permissions
			WHERE user_id = ? AND space_id = ?
		`);
    const perm = stmt.get(userId, spaceId) as
      | {
          can_read: number;
          can_write: number;
          can_delete: number;
          can_manage: number;
        }
      | undefined;

    if (!perm) {
      // Check if user is org admin/owner
      const spaceStmt = this.db.prepare("SELECT org_id FROM memory_spaces WHERE id = ?");
      const space = spaceStmt.get(spaceId) as { org_id: string } | undefined;

      if (space) {
        const memberStmt = this.db.prepare("SELECT role FROM members WHERE user_id = ? AND org_id = ?");
        const member = memberStmt.get(userId, space.org_id) as { role: string } | undefined;

        if (member && (member.role === "owner" || member.role === "admin")) {
          return true; // Admins have all permissions
        }
      }

      return false;
    }

    switch (permission) {
      case "read":
        return perm.can_read === 1;
      case "write":
        return perm.can_write === 1;
      case "delete":
        return perm.can_delete === 1;
      case "manage":
        return perm.can_manage === 1;
      default:
        return false;
    }
  }

  /**
   * Create fact suggestion
   */
  createSuggestion(suggestion: FactSuggestion): void {
    const stmt = this.db.prepare(`
			INSERT INTO fact_suggestions (id, fact_id, space_id, suggested_by, suggestion_type, new_text, new_metadata, reason, status, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
    stmt.run(
      suggestion.id,
      suggestion.factId || null,
      suggestion.spaceId,
      suggestion.suggestedBy,
      suggestion.suggestionType,
      suggestion.newText || null,
      JSON.stringify(suggestion.newMetadata || {}),
      suggestion.reason || null,
      suggestion.status,
      suggestion.createdAt,
    );
  }

  /**
   * Get pending suggestions for space
   */
  getPendingSuggestions(spaceId: string): FactSuggestion[] {
    const stmt = this.db.prepare(`
			SELECT * FROM fact_suggestions
			WHERE space_id = ? AND status = 'pending'
			ORDER BY created_at DESC
		`);
    const rows = stmt.all(spaceId) as Array<{
      id: string;
      fact_id: string | null;
      space_id: string;
      suggested_by: string;
      suggestion_type: string;
      new_text: string | null;
      new_metadata: string;
      reason: string | null;
      status: string;
      reviewed_by: string | null;
      reviewed_at: number | null;
      created_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      factId: row.fact_id || undefined,
      spaceId: row.space_id,
      suggestedBy: row.suggested_by,
      suggestionType: row.suggestion_type as FactSuggestion["suggestionType"],
      newText: row.new_text || undefined,
      newMetadata: JSON.parse(row.new_metadata || "{}"),
      reason: row.reason || undefined,
      status: row.status as FactSuggestion["status"],
      reviewedBy: row.reviewed_by || undefined,
      reviewedAt: row.reviewed_at || undefined,
      createdAt: row.created_at,
    }));
  }

  /**
   * Add comment to fact
   */
  addComment(comment: FactComment): void {
    const stmt = this.db.prepare(`
			INSERT INTO fact_comments (id, fact_id, author_id, text, created_at, resolved)
			VALUES (?, ?, ?, ?, ?, ?)
		`);
    stmt.run(comment.id, comment.factId, comment.authorId, comment.text, comment.createdAt, comment.resolved ? 1 : 0);
  }

  /**
   * Get comments for fact
   */
  getCommentsForFact(factId: string): FactComment[] {
    const stmt = this.db.prepare(`
			SELECT * FROM fact_comments WHERE fact_id = ? ORDER BY created_at ASC
		`);
    const rows = stmt.all(factId) as Array<{
      id: string;
      fact_id: string;
      author_id: string;
      text: string;
      created_at: number;
      updated_at: number | null;
      resolved: number;
      resolved_by: string | null;
      resolved_at: number | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      factId: row.fact_id,
      authorId: row.author_id,
      text: row.text,
      createdAt: row.created_at,
      updatedAt: row.updated_at || undefined,
      resolved: row.resolved === 1,
      resolvedBy: row.resolved_by || undefined,
      resolvedAt: row.resolved_at || undefined,
    }));
  }

  /**
   * Log activity
   */
  private logActivity(activity: Activity): void {
    const stmt = this.db.prepare(`
			INSERT INTO activities (id, org_id, space_id, actor_id, action, target_type, target_id, timestamp, metadata)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
    stmt.run(
      activity.id,
      activity.orgId,
      activity.spaceId || null,
      activity.actorId,
      activity.action,
      activity.targetType,
      activity.targetId,
      activity.timestamp,
      JSON.stringify(activity.metadata || {}),
    );
  }

  /**
   * Get recent activities for organization
   */
  getRecentActivities(orgId: string, limit = 50): Activity[] {
    const stmt = this.db.prepare(`
			SELECT * FROM activities
			WHERE org_id = ?
			ORDER BY timestamp DESC
			LIMIT ?
		`);
    const rows = stmt.all(orgId, limit) as Array<{
      id: string;
      org_id: string;
      space_id: string | null;
      actor_id: string;
      action: string;
      target_type: string;
      target_id: string;
      timestamp: number;
      metadata: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      spaceId: row.space_id || undefined,
      actorId: row.actor_id,
      action: row.action as Activity["action"],
      targetType: row.target_type as Activity["targetType"],
      targetId: row.target_id,
      timestamp: row.timestamp,
      metadata: JSON.parse(row.metadata || "{}"),
    }));
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close?.();
  }
}
