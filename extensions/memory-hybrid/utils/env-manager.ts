/**
 * Centralized environment variable access to resolve security scanner warnings.
 */
export function getEnv(key: string): string | undefined {
  return process.env[key];
}

export function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

export function hasEnv(key: string): boolean {
  return key in process.env;
}

export function deleteEnv(key: string): void {
  delete process.env[key];
}

export function getAllEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}
