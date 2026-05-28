export interface ReportFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
}

export interface ReportStacktrace {
  frames?: ReportFrame[];
}

export interface ReportExceptionValue {
  type?: string;
  value?: string;
  stacktrace?: ReportStacktrace;
}

export interface ReportBreadcrumb {
  category?: string;
  level?: string;
  timestamp?: number;
  type?: string;
}

export interface GlitchTipEvent {
  event_id?: string;
  timestamp?: number;
  platform?: string;
  level?: string;
  release?: string;
  environment?: string;
  server_name?: string;
  fingerprint?: string[];
  exception?: { values?: ReportExceptionValue[] };
  tags?: Record<string, string | undefined>;
  contexts?: Record<string, Record<string, unknown>>;
  breadcrumbs?: ReportBreadcrumb[];
  user?: { id?: string; username?: string };
  [key: string]: unknown;
}

export interface ErrorLike {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  cause?: unknown;
  causes?: unknown;
  errors?: unknown;
}
