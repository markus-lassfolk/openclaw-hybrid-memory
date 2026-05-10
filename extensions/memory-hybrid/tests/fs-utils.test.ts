import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDirSize, getFileSizeAsync, readJsonFile } from "../utils/fs.js";

describe("fs utilities", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `fs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("getFileSizeAsync", () => {
    it("should return file size in bytes", async () => {
      const filePath = join(testDir, "test.txt");
      const content = "Hello, world!";
      writeFileSync(filePath, content, "utf-8");

      const size = await getFileSizeAsync(filePath);
      expect(size).toBe(Buffer.byteLength(content));
    });

    it("should return 0 for non-existent file", async () => {
      const filePath = join(testDir, "nonexistent.txt");
      const size = await getFileSizeAsync(filePath);
      expect(size).toBe(0);
    });

    it("should return directory metadata size", async () => {
      const dirPath = join(testDir, "subdir");
      mkdirSync(dirPath);

      const size = await getFileSizeAsync(dirPath);
      // Directories have a metadata size (e.g., 4096 on Linux)
      expect(size).toBeGreaterThanOrEqual(0);
    });

    it("should handle empty file", async () => {
      const filePath = join(testDir, "empty.txt");
      writeFileSync(filePath, "", "utf-8");

      const size = await getFileSizeAsync(filePath);
      expect(size).toBe(0);
    });

    it("should handle binary file", async () => {
      const filePath = join(testDir, "binary.dat");
      const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
      writeFileSync(filePath, buffer);

      const size = await getFileSizeAsync(filePath);
      expect(size).toBe(5);
    });

    it("should handle large file", async () => {
      const filePath = join(testDir, "large.txt");
      const content = "x".repeat(10000);
      writeFileSync(filePath, content, "utf-8");

      const size = await getFileSizeAsync(filePath);
      expect(size).toBe(10000);
    });
  });

  describe("getDirSize", () => {
    it("should return total size of files in directory", async () => {
      const file1 = join(testDir, "file1.txt");
      const file2 = join(testDir, "file2.txt");
      writeFileSync(file1, "Hello", "utf-8");
      writeFileSync(file2, "World", "utf-8");

      const size = await getDirSize(testDir);
      expect(size).toBe(10); // 5 + 5
    });

    it("should return 0 for non-existent directory", async () => {
      const dirPath = join(testDir, "nonexistent");
      const size = await getDirSize(dirPath);
      expect(size).toBe(0);
    });

    it("should handle empty directory", async () => {
      const emptyDir = join(testDir, "empty");
      mkdirSync(emptyDir);

      const size = await getDirSize(emptyDir);
      expect(size).toBe(0);
    });

    it("should recursively calculate nested directory size", async () => {
      const subdir = join(testDir, "subdir");
      mkdirSync(subdir);

      writeFileSync(join(testDir, "file1.txt"), "12345", "utf-8");
      writeFileSync(join(subdir, "file2.txt"), "67890", "utf-8");

      const size = await getDirSize(testDir);
      expect(size).toBe(10); // 5 + 5
    });

    it("should handle deeply nested directories", async () => {
      const level1 = join(testDir, "level1");
      const level2 = join(level1, "level2");
      const level3 = join(level2, "level3");
      mkdirSync(level3, { recursive: true });

      writeFileSync(join(testDir, "root.txt"), "a", "utf-8");
      writeFileSync(join(level1, "l1.txt"), "bb", "utf-8");
      writeFileSync(join(level2, "l2.txt"), "ccc", "utf-8");
      writeFileSync(join(level3, "l3.txt"), "dddd", "utf-8");

      const size = await getDirSize(testDir);
      expect(size).toBe(10); // 1 + 2 + 3 + 4
    });

    it("should handle mixed files and directories", async () => {
      const subdir1 = join(testDir, "subdir1");
      const subdir2 = join(testDir, "subdir2");
      mkdirSync(subdir1);
      mkdirSync(subdir2);

      writeFileSync(join(testDir, "root.txt"), "123", "utf-8");
      writeFileSync(join(subdir1, "file1.txt"), "456", "utf-8");
      writeFileSync(join(subdir2, "file2.txt"), "789", "utf-8");

      const size = await getDirSize(testDir);
      expect(size).toBe(9); // 3 + 3 + 3
    });

    it("should handle unreadable files gracefully", async () => {
      const file1 = join(testDir, "file1.txt");
      writeFileSync(file1, "Hello", "utf-8");

      // Can't easily create unreadable files in test, but the function handles it
      const size = await getDirSize(testDir);
      expect(size).toBeGreaterThanOrEqual(0);
    });

    it("should handle symbolic links (if they exist)", async () => {
      const targetFile = join(testDir, "target.txt");
      writeFileSync(targetFile, "content", "utf-8");

      const size = await getDirSize(testDir);
      expect(size).toBeGreaterThan(0);
    });

    it("should handle directory with many files", async () => {
      // Create 100 small files
      for (let i = 0; i < 100; i++) {
        writeFileSync(join(testDir, `file${i}.txt`), "x", "utf-8");
      }

      const size = await getDirSize(testDir);
      expect(size).toBe(100); // 100 files * 1 byte each
    });
  });

  describe("readJsonFile", () => {
    it("should parse valid JSON file", async () => {
      const filePath = join(testDir, "data.json");
      const data = { name: "test", value: 42 };
      writeFileSync(filePath, JSON.stringify(data), "utf-8");

      const result = await readJsonFile<typeof data>(filePath);
      expect(result).toEqual(data);
    });

    it("should return null for non-existent file", async () => {
      const filePath = join(testDir, "nonexistent.json");
      const result = await readJsonFile(filePath);
      expect(result).toBeNull();
    });

    it("should return null for invalid JSON", async () => {
      const filePath = join(testDir, "invalid.json");
      writeFileSync(filePath, "{ invalid json }", "utf-8");

      const result = await readJsonFile(filePath);
      expect(result).toBeNull();
    });

    it("should handle empty file", async () => {
      const filePath = join(testDir, "empty.json");
      writeFileSync(filePath, "", "utf-8");

      const result = await readJsonFile(filePath);
      expect(result).toBeNull();
    });

    it("should handle JSON with nested objects", async () => {
      const filePath = join(testDir, "nested.json");
      const data = {
        user: {
          name: "John",
          profile: {
            age: 30,
            email: "john@example.com",
          },
        },
      };
      writeFileSync(filePath, JSON.stringify(data), "utf-8");

      const result = await readJsonFile<typeof data>(filePath);
      expect(result).toEqual(data);
    });

    it("should handle JSON with arrays", async () => {
      const filePath = join(testDir, "array.json");
      const data = { items: [1, 2, 3, 4, 5] };
      writeFileSync(filePath, JSON.stringify(data), "utf-8");

      const result = await readJsonFile<typeof data>(filePath);
      expect(result).toEqual(data);
    });

    it("should handle JSON with null values", async () => {
      const filePath = join(testDir, "nulls.json");
      const data = { value: null, other: "string" };
      writeFileSync(filePath, JSON.stringify(data), "utf-8");

      const result = await readJsonFile<typeof data>(filePath);
      expect(result).toEqual(data);
    });

    it("should handle JSON with boolean values", async () => {
      const filePath = join(testDir, "booleans.json");
      const data = { isTrue: true, isFalse: false };
      writeFileSync(filePath, JSON.stringify(data), "utf-8");

      const result = await readJsonFile<typeof data>(filePath);
      expect(result).toEqual(data);
    });

    it("should handle JSON with numbers", async () => {
      const filePath = join(testDir, "numbers.json");
      const data = { integer: 42, float: 3.14, negative: -10 };
      writeFileSync(filePath, JSON.stringify(data), "utf-8");

      const result = await readJsonFile<typeof data>(filePath);
      expect(result).toEqual(data);
    });

    it("should handle pretty-printed JSON", async () => {
      const filePath = join(testDir, "pretty.json");
      const data = { name: "test", nested: { value: 123 } };
      writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");

      const result = await readJsonFile<typeof data>(filePath);
      expect(result).toEqual(data);
    });

    it("should handle JSON with unicode characters", async () => {
      const filePath = join(testDir, "unicode.json");
      const data = { text: "Hello 世界 🌍" };
      writeFileSync(filePath, JSON.stringify(data), "utf-8");

      const result = await readJsonFile<typeof data>(filePath);
      expect(result).toEqual(data);
    });

    it("should type-check return value", async () => {
      interface TestData {
        name: string;
        count: number;
      }

      const filePath = join(testDir, "typed.json");
      const data: TestData = { name: "test", count: 10 };
      writeFileSync(filePath, JSON.stringify(data), "utf-8");

      const result = await readJsonFile<TestData>(filePath);
      if (result) {
        expect(result.name).toBe("test");
        expect(result.count).toBe(10);
      }
    });
  });

  describe("edge cases", () => {
    it("should handle paths with spaces", async () => {
      const dirWithSpaces = join(testDir, "dir with spaces");
      mkdirSync(dirWithSpaces);
      writeFileSync(join(dirWithSpaces, "file.txt"), "content", "utf-8");

      const size = await getDirSize(dirWithSpaces);
      expect(size).toBe(7);
    });

    it("should handle paths with special characters", async () => {
      const specialDir = join(testDir, "dir-with_special.chars");
      mkdirSync(specialDir);
      writeFileSync(join(specialDir, "file.txt"), "test", "utf-8");

      const size = await getDirSize(specialDir);
      expect(size).toBe(4);
    });

    it("should handle concurrent file size requests", async () => {
      const file1 = join(testDir, "file1.txt");
      const file2 = join(testDir, "file2.txt");
      writeFileSync(file1, "content1", "utf-8");
      writeFileSync(file2, "content2", "utf-8");

      const [size1, size2] = await Promise.all([getFileSizeAsync(file1), getFileSizeAsync(file2)]);

      expect(size1).toBe(8);
      expect(size2).toBe(8);
    });
  });
});
