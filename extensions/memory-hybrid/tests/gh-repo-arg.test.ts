import { describe, expect, it } from "vitest";
import { isValidGhRepoArg } from "../utils/gh-repo-arg.js";

describe("gh-repo-arg", () => {
  describe("isValidGhRepoArg - Security validation for gh --repo flag", () => {
    describe("Valid repository identifiers", () => {
      it("should accept standard owner/repo format", () => {
        expect(isValidGhRepoArg("owner/repo")).toBe(true);
      });

      it("should accept alphanumeric characters", () => {
        expect(isValidGhRepoArg("user123/repo456")).toBe(true);
      });

      it("should accept hyphens", () => {
        expect(isValidGhRepoArg("my-org/my-repo")).toBe(true);
      });

      it("should accept underscores", () => {
        expect(isValidGhRepoArg("my_org/my_repo")).toBe(true);
      });

      it("should accept dots", () => {
        expect(isValidGhRepoArg("my.org/my.repo")).toBe(true);
      });

      it("should accept mixed valid characters", () => {
        expect(isValidGhRepoArg("my-org_123/my.repo-456")).toBe(true);
      });

      it("should accept single character owner and repo", () => {
        expect(isValidGhRepoArg("a/b")).toBe(true);
      });

      it("should accept long names", () => {
        expect(isValidGhRepoArg("very-long-organization-name/very-long-repository-name-here")).toBe(true);
      });

      it("should accept numbers at start and end", () => {
        expect(isValidGhRepoArg("123org456/789repo012")).toBe(true);
      });
    });

    describe("Invalid formats - Security: Flag injection prevention", () => {
      it("should reject leading hyphen (flag injection)", () => {
        expect(isValidGhRepoArg("-flag/repo")).toBe(false);
      });

      it("should reject leading hyphen in repo name (flag injection)", () => {
        expect(isValidGhRepoArg("owner/-flag")).toBe(false);
      });

      it("should reject double hyphen (flag injection)", () => {
        expect(isValidGhRepoArg("--help/repo")).toBe(false);
      });

      it("should reject leading hyphen with valid format after", () => {
        expect(isValidGhRepoArg("-owner/valid-repo")).toBe(false);
      });
    });

    describe("Invalid formats - Path separators", () => {
      it("should reject backslash (Windows path separator)", () => {
        expect(isValidGhRepoArg("owner\\repo")).toBe(false);
      });

      it("should reject null byte", () => {
        expect(isValidGhRepoArg("owner\0repo")).toBe(false);
      });

      it("should reject multiple forward slashes", () => {
        expect(isValidGhRepoArg("owner/repo/extra")).toBe(false);
      });

      it("should reject no forward slash", () => {
        expect(isValidGhRepoArg("ownerrepo")).toBe(false);
      });

      it("should reject leading forward slash", () => {
        expect(isValidGhRepoArg("/owner/repo")).toBe(false);
      });

      it("should reject trailing forward slash", () => {
        expect(isValidGhRepoArg("owner/repo/")).toBe(false);
      });
    });

    describe("Invalid formats - Empty and null values", () => {
      it("should reject null", () => {
        expect(isValidGhRepoArg(null)).toBe(false);
      });

      it("should reject undefined", () => {
        expect(isValidGhRepoArg(undefined)).toBe(false);
      });

      it("should reject empty string", () => {
        expect(isValidGhRepoArg("")).toBe(false);
      });

      it("should reject whitespace only", () => {
        expect(isValidGhRepoArg("   ")).toBe(false);
      });
    });

    describe("Invalid formats - Special characters", () => {
      it("should reject spaces", () => {
        expect(isValidGhRepoArg("my org/my repo")).toBe(false);
      });

      it("should reject @ symbol", () => {
        expect(isValidGhRepoArg("my@org/repo")).toBe(false);
      });

      it("should reject # symbol", () => {
        expect(isValidGhRepoArg("owner/repo#123")).toBe(false);
      });

      it("should reject $ symbol", () => {
        expect(isValidGhRepoArg("owner$/repo")).toBe(false);
      });

      it("should reject % symbol", () => {
        expect(isValidGhRepoArg("owner%/repo")).toBe(false);
      });

      it("should reject & symbol", () => {
        expect(isValidGhRepoArg("owner&/repo")).toBe(false);
      });

      it("should reject * symbol", () => {
        expect(isValidGhRepoArg("owner*/repo")).toBe(false);
      });

      it("should reject parentheses", () => {
        expect(isValidGhRepoArg("owner()/repo")).toBe(false);
      });

      it("should reject brackets", () => {
        expect(isValidGhRepoArg("owner[]/repo")).toBe(false);
      });

      it("should reject braces", () => {
        expect(isValidGhRepoArg("owner{}/repo")).toBe(false);
      });

      it("should reject pipe symbol", () => {
        expect(isValidGhRepoArg("owner|repo")).toBe(false);
      });

      it("should reject semicolon", () => {
        expect(isValidGhRepoArg("owner;/repo")).toBe(false);
      });

      it("should reject quotes", () => {
        expect(isValidGhRepoArg('owner"/repo')).toBe(false);
      });

      it("should reject backticks", () => {
        expect(isValidGhRepoArg("owner`/repo")).toBe(false);
      });
    });

    describe("Invalid formats - Edge cases", () => {
      it("should reject leading hyphen in owner", () => {
        expect(isValidGhRepoArg("-owner/repo")).toBe(false);
      });

      it("should reject trailing hyphen in owner", () => {
        expect(isValidGhRepoArg("owner-/repo")).toBe(false);
      });

      it("should reject leading hyphen in repo", () => {
        expect(isValidGhRepoArg("owner/-repo")).toBe(false);
      });

      it("should reject trailing hyphen in repo", () => {
        expect(isValidGhRepoArg("owner/repo-")).toBe(false);
      });

      it("should reject leading dot in owner", () => {
        expect(isValidGhRepoArg(".owner/repo")).toBe(false);
      });

      it("should reject trailing dot in owner", () => {
        expect(isValidGhRepoArg("owner./repo")).toBe(false);
      });

      it("should reject leading underscore in owner", () => {
        expect(isValidGhRepoArg("_owner/repo")).toBe(false);
      });

      it("should reject trailing underscore in repo", () => {
        expect(isValidGhRepoArg("owner/repo_")).toBe(false);
      });

      it("should reject only slash", () => {
        expect(isValidGhRepoArg("/")).toBe(false);
      });

      it("should reject owner without repo", () => {
        expect(isValidGhRepoArg("owner/")).toBe(false);
      });

      it("should reject repo without owner", () => {
        expect(isValidGhRepoArg("/repo")).toBe(false);
      });
    });

    describe("Real-world examples", () => {
      it("should accept GitHub username with hyphen", () => {
        expect(isValidGhRepoArg("microsoft/vscode")).toBe(true);
      });

      it("should accept organization with hyphen", () => {
        expect(isValidGhRepoArg("facebook/react")).toBe(true);
      });

      it("should accept org with numbers", () => {
        expect(isValidGhRepoArg("vercel/next.js")).toBe(true);
      });

      it("should accept mixed case (though GitHub normalizes)", () => {
        expect(isValidGhRepoArg("MyOrg/MyRepo")).toBe(true);
      });

      it("should accept hyphenated repo names", () => {
        expect(isValidGhRepoArg("nodejs/node-v8")).toBe(true);
      });

      it("should accept dotted repo names", () => {
        expect(isValidGhRepoArg("angular/angular.js")).toBe(true);
      });
    });

    describe("Security test cases from issue #869", () => {
      it("should prevent command injection via leading dash", () => {
        // Issue #869: Prevent flag injection
        expect(isValidGhRepoArg("--help")).toBe(false);
      });

      it("should prevent command injection via multiple dashes", () => {
        expect(isValidGhRepoArg("---version")).toBe(false);
      });

      it("should prevent path traversal", () => {
        expect(isValidGhRepoArg("../../../etc/passwd")).toBe(false);
      });

      it("should prevent Windows path injection", () => {
        expect(isValidGhRepoArg("C:\\Windows\\System32")).toBe(false);
      });

      it("should prevent command substitution attempts", () => {
        expect(isValidGhRepoArg("owner/$(whoami)")).toBe(false);
      });

      it("should prevent shell expansion attempts", () => {
        expect(isValidGhRepoArg("owner/${HOME}")).toBe(false);
      });
    });
  });
});
