import { CATEGORY_COLORS } from "./mock-data";

export function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] || CATEGORY_COLORS.other;
}

export function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return `${Math.floor(seconds / 604800)}w ago`;
}

export function formatAbsoluteTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

export const SEVERITY_COLORS: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#f59e0b",
  low: "#6b7280",
};

export const STATUS_COLORS: Record<string, string> = {
  open: "#3b82f6",
  diagnosed: "#f59e0b",
  "fix-attempted": "#8b5cf6",
  resolved: "#10b981",
  verified: "#06b6d4",
  "wont-fix": "#6b7280",
};
