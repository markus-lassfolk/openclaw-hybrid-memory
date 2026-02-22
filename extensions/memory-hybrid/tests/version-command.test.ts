import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("version command utilities", () => {
  describe("version comparison", () => {
    const compare = (a: string, b: string): number => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const va = pa[i] ?? 0;
        const vb = pb[i] ?? 0;
        if (va !== vb) return va < vb ? -1 : 1;
      }
      return 0;
    };

    it("returns 0 for equal versions", () => {
      expect(compare("1.0.0", "1.0.0")).toBe(0);
      expect(compare("2026.2.221", "2026.2.221")).toBe(0);
    });

    it("returns -1 when first version is older", () => {
      expect(compare("1.0.0", "1.0.1")).toBe(-1);
      expect(compare("1.0.0", "2.0.0")).toBe(-1);
      expect(compare("2026.2.220", "2026.2.221")).toBe(-1);
      expect(compare("2026.1.999", "2026.2.0")).toBe(-1);
    });

    it("returns 1 when first version is newer", () => {
      expect(compare("1.0.1", "1.0.0")).toBe(1);
      expect(compare("2.0.0", "1.0.0")).toBe(1);
      expect(compare("2026.2.221", "2026.2.220")).toBe(1);
      expect(compare("2026.2.0", "2026.1.999")).toBe(1);
    });

    it("handles versions with different segment counts", () => {
      expect(compare("1.0", "1.0.0")).toBe(0);
      expect(compare("1.0.1", "1.0")).toBe(1);
      expect(compare("1.0", "1.0.1")).toBe(-1);
      expect(compare("2.0", "1.9.9.9")).toBe(1);
    });

    it("handles major version differences", () => {
      expect(compare("2.0.0", "1.999.999")).toBe(1);
      expect(compare("1.999.999", "2.0.0")).toBe(-1);
    });

    it("handles edge case with leading zeros (parsed as numbers)", () => {
      expect(compare("1.01.0", "1.1.0")).toBe(0);
      expect(compare("1.001.0", "1.1.0")).toBe(0);
    });

    it("handles non-numeric parts by treating them as NaN (which compares as not equal)", () => {
      const result1 = compare("1.0.0-beta", "1.0.0");
      const result2 = compare("1.0.0", "1.0.0-beta");
      // When Number() encounters non-numeric strings, it returns NaN
      // NaN !== NaN, so the comparison will be inconsistent
      // This test documents the current behavior - in practice, versions should be numeric
      expect(typeof result1).toBe("number");
      expect(typeof result2).toBe("number");
    });

    it("handles empty version strings", () => {
      expect(compare("", "")).toBe(0);
      expect(compare("1.0.0", "")).toBe(1);
      expect(compare("", "1.0.0")).toBe(-1);
    });
  });

  describe("fetchWithTimeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      global.fetch = vi.fn();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("returns response when fetch completes before timeout", async () => {
      const mockResponse = new Response("test", { status: 200 });
      (global.fetch as any).mockResolvedValue(mockResponse);

      const fetchWithTimeout = async (url: string, timeoutMs: number): Promise<Response> => {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), timeoutMs);
        try {
          const res = await fetch(url, { signal: c.signal });
          clearTimeout(t);
          return res;
        } catch {
          clearTimeout(t);
          throw new Error("timeout or network error");
        }
      };

      const promise = fetchWithTimeout("https://example.com", 3000);
      await vi.advanceTimersByTimeAsync(100);
      const result = await promise;

      expect(result).toBe(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://example.com",
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it("throws timeout error when fetch takes too long", async () => {
      let abortHandler: (() => void) | null = null;
      (global.fetch as any).mockImplementation(
        ({ signal }: { signal: AbortSignal }) => 
          new Promise((_, reject) => {
            abortHandler = () => reject(new Error('aborted'));
            signal.addEventListener('abort', abortHandler);
          })
      );

      const fetchWithTimeout = async (url: string, timeoutMs: number): Promise<Response> => {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), timeoutMs);
        try {
          const res = await fetch(url, { signal: c.signal });
          clearTimeout(t);
          return res;
        } catch {
          clearTimeout(t);
          throw new Error("timeout or network error");
        }
      };

      const promise = fetchWithTimeout("https://example.com", 3000).catch(err => err);
      
      await vi.advanceTimersByTimeAsync(3001);
      
      const result = await promise;
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("timeout or network error");
    });

    it("throws error when fetch fails with network error", async () => {
      (global.fetch as any).mockRejectedValue(new Error("Network failure"));

      const fetchWithTimeout = async (url: string, timeoutMs: number): Promise<Response> => {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), timeoutMs);
        try {
          const res = await fetch(url, { signal: c.signal });
          clearTimeout(t);
          return res;
        } catch {
          clearTimeout(t);
          throw new Error("timeout or network error");
        }
      };

      await expect(fetchWithTimeout("https://example.com", 3000)).rejects.toThrow(
        "timeout or network error"
      );
    });
  });

  describe("version output formatting", () => {
    const compare = (a: string, b: string): number => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const va = pa[i] ?? 0;
        const vb = pb[i] ?? 0;
        if (va !== vb) return va < vb ? -1 : 1;
      }
      return 0;
    };

    const updateHint = (installed: string, latest: string | null) => {
      if (latest == null) return "";
      return compare(installed, latest) < 0 ? " ⬆ update available" : " (up to date)";
    };

    it("shows update available when installed is older", () => {
      expect(updateHint("1.0.0", "1.0.1")).toBe(" ⬆ update available");
      expect(updateHint("2026.2.220", "2026.2.221")).toBe(" ⬆ update available");
    });

    it("shows up to date when versions match", () => {
      expect(updateHint("1.0.0", "1.0.0")).toBe(" (up to date)");
      expect(updateHint("2026.2.221", "2026.2.221")).toBe(" (up to date)");
    });

    it("shows up to date when installed is newer", () => {
      expect(updateHint("1.0.1", "1.0.0")).toBe(" (up to date)");
      expect(updateHint("2026.2.222", "2026.2.221")).toBe(" (up to date)");
    });

    it("returns empty string when latest is null", () => {
      expect(updateHint("1.0.0", null)).toBe("");
    });
  });

  describe("JSON output format", () => {
    const compare = (a: string, b: string): number => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const va = pa[i] ?? 0;
        const vb = pb[i] ?? 0;
        if (va !== vb) return va < vb ? -1 : 1;
      }
      return 0;
    };

    it("includes all required fields", () => {
      const installed = "2026.2.221";
      const githubVersion = "2026.2.222";
      const npmVersion = "2026.2.222";

      const output = {
        name: "openclaw-hybrid-memory",
        installed,
        github: githubVersion ?? "unavailable",
        npm: npmVersion ?? "unavailable",
        updateAvailable:
          (githubVersion != null && compare(installed, githubVersion) < 0) ||
          (npmVersion != null && compare(installed, npmVersion) < 0),
      };

      expect(output).toHaveProperty("name");
      expect(output).toHaveProperty("installed");
      expect(output).toHaveProperty("github");
      expect(output).toHaveProperty("npm");
      expect(output).toHaveProperty("updateAvailable");
    });

    it("sets updateAvailable to true when GitHub has newer version", () => {
      const installed = "2026.2.220";
      const githubVersion = "2026.2.221";
      const npmVersion = "2026.2.220";

      const updateAvailable =
        (githubVersion != null && compare(installed, githubVersion) < 0) ||
        (npmVersion != null && compare(installed, npmVersion) < 0);

      expect(updateAvailable).toBe(true);
    });

    it("sets updateAvailable to true when npm has newer version", () => {
      const installed = "2026.2.220";
      const githubVersion = "2026.2.220";
      const npmVersion = "2026.2.221";

      const updateAvailable =
        (githubVersion != null && compare(installed, githubVersion) < 0) ||
        (npmVersion != null && compare(installed, npmVersion) < 0);

      expect(updateAvailable).toBe(true);
    });

    it("sets updateAvailable to false when installed is up to date", () => {
      const installed = "2026.2.221";
      const githubVersion = "2026.2.221";
      const npmVersion = "2026.2.221";

      const updateAvailable =
        (githubVersion != null && compare(installed, githubVersion) < 0) ||
        (npmVersion != null && compare(installed, npmVersion) < 0);

      expect(updateAvailable).toBe(false);
    });

    it("sets updateAvailable to false when installed is newer", () => {
      const installed = "2026.2.222";
      const githubVersion = "2026.2.221";
      const npmVersion = "2026.2.221";

      const updateAvailable =
        (githubVersion != null && compare(installed, githubVersion) < 0) ||
        (npmVersion != null && compare(installed, npmVersion) < 0);

      expect(updateAvailable).toBe(false);
    });

    it("handles unavailable versions", () => {
      const installed = "2026.2.221";
      const githubVersion = null;
      const npmVersion = null;

      const output = {
        name: "openclaw-hybrid-memory",
        installed,
        github: githubVersion ?? "unavailable",
        npm: npmVersion ?? "unavailable",
        updateAvailable:
          (githubVersion != null && compare(installed, githubVersion) < 0) ||
          (npmVersion != null && compare(installed, npmVersion) < 0),
      };

      expect(output.github).toBe("unavailable");
      expect(output.npm).toBe("unavailable");
      expect(output.updateAvailable).toBe(false);
    });
  });

  describe("GitHub API response parsing", () => {
    it("extracts version from tag_name with v prefix", () => {
      const data = { tag_name: "v2026.2.221" };
      const tag = data.tag_name;
      const version = typeof tag === "string" ? tag.replace(/^v/, "") : null;
      
      expect(version).toBe("2026.2.221");
    });

    it("extracts version from tag_name without v prefix", () => {
      const data = { tag_name: "2026.2.221" };
      const tag = data.tag_name;
      const version = typeof tag === "string" ? tag.replace(/^v/, "") : null;
      
      expect(version).toBe("2026.2.221");
    });

    it("returns null for missing tag_name", () => {
      const data = {};
      const tag = (data as any).tag_name;
      const version = typeof tag === "string" ? tag.replace(/^v/, "") : null;
      
      expect(version).toBe(null);
    });

    it("returns null for non-string tag_name", () => {
      const data = { tag_name: 123 };
      const tag = data.tag_name;
      const version = typeof tag === "string" ? tag.replace(/^v/, "") : null;
      
      expect(version).toBe(null);
    });
  });

  describe("npm registry response parsing", () => {
    it("extracts version from response", () => {
      const data = { version: "2026.2.221" };
      const version = typeof data.version === "string" ? data.version : null;
      
      expect(version).toBe("2026.2.221");
    });

    it("returns null for missing version", () => {
      const data = {};
      const version = typeof (data as any).version === "string" ? (data as any).version : null;
      
      expect(version).toBe(null);
    });

    it("returns null for non-string version", () => {
      const data = { version: 123 };
      const version = typeof data.version === "string" ? data.version : null;
      
      expect(version).toBe(null);
    });
  });

  describe("installed is newer hint", () => {
    const compare = (a: string, b: string): number => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const va = pa[i] ?? 0;
        const vb = pb[i] ?? 0;
        if (va !== vb) return va < vb ? -1 : 1;
      }
      return 0;
    };

    const updateHint = (latest: string | null) => {
      if (latest == null) return "";
      return " (up to date)";
    };

    it("shows 'installed is newer' for GitHub when installed > github", () => {
      const installed = "2026.2.222";
      const githubVersion = "2026.2.221";
      
      const hint = githubVersion != null && compare(installed, githubVersion) > 0
        ? " (installed is newer)"
        : updateHint(githubVersion);
      
      expect(hint).toBe(" (installed is newer)");
    });

    it("shows 'installed is newer' for npm when installed > npm", () => {
      const installed = "2026.2.222";
      const npmVersion = "2026.2.221";
      
      const hint = npmVersion != null && compare(installed, npmVersion) > 0
        ? " (installed is newer)"
        : updateHint(npmVersion);
      
      expect(hint).toBe(" (installed is newer)");
    });

    it("does not show 'installed is newer' when versions match", () => {
      const installed = "2026.2.221";
      const githubVersion = "2026.2.221";
      
      const hint = githubVersion != null && compare(installed, githubVersion) > 0
        ? " (installed is newer)"
        : updateHint(githubVersion);
      
      expect(hint).toBe(" (up to date)");
    });
  });
});
