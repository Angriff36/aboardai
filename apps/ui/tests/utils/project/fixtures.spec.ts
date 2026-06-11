/**
 * Tests for project fixture utilities
 *
 * Tests for path traversal guard and file operations in test fixtures
 */

import { test, expect } from '@playwright/test';
import {
  createMemoryFileOnDisk,
  memoryFileExistsOnDisk,
  resetMemoryDirectory,
  createContextFileOnDisk,
  contextFileExistsOnDisk,
  resetContextDirectory,
} from './fixtures';

test.describe('Memory Fixture Utilities', () => {
  test.beforeEach(() => {
    resetMemoryDirectory();
  });

  test.afterEach(() => {
    resetMemoryDirectory();
  });

  test('should create and detect a valid memory file', () => {
    const filename = 'test-file.md';
    const content = '# Test Content';

    createMemoryFileOnDisk(filename, content);

    expect(memoryFileExistsOnDisk(filename)).toBe(true);
  });

  test('should return false for non-existent file', () => {
    expect(memoryFileExistsOnDisk('non-existent.md')).toBe(false);
  });

  test('should reject path traversal attempt with ../', () => {
    const maliciousFilename = '../../../etc/passwd';

    expect(() => {
      createMemoryFileOnDisk(maliciousFilename, 'malicious content');
    }).toThrow('Invalid memory filename');

    expect(() => {
      memoryFileExistsOnDisk(maliciousFilename);
    }).toThrow('Invalid memory filename');
  });

  test('should handle Windows-style path traversal attempt ..\\ (platform-dependent)', () => {
    const maliciousFilename = '..\\..\\..\\windows\\system32\\config';

    // Platform-dependent behavior:
    // - On Unix/macOS: backslash is a valid filename character (not a path separator),
    //   so path.resolve does NOT traverse directories and the guard does NOT throw.
    // - On Windows: backslash IS a path separator, so path.resolve WILL traverse directories
    //   and the guard correctly throws 'Invalid memory filename'.
    if (process.platform === 'win32') {
      expect(() => {
        memoryFileExistsOnDisk(maliciousFilename);
      }).toThrow('Invalid memory filename');
    } else {
      expect(() => {
        memoryFileExistsOnDisk(maliciousFilename);
      }).not.toThrow();
    }
  });

  test('should reject absolute path attempt', () => {
    const maliciousFilename = '/etc/passwd';

    expect(() => {
      createMemoryFileOnDisk(maliciousFilename, 'malicious content');
    }).toThrow('Invalid memory filename');

    expect(() => {
      memoryFileExistsOnDisk(maliciousFilename);
    }).toThrow('Invalid memory filename');
  });

  test('should accept nested paths within memory directory', () => {
    // Note: This tests the boundary - if subdirectories are supported,
    // this should pass; if not, it should throw
    const nestedFilename = 'subfolder/nested-file.md';

    // Currently, the implementation doesn't create subdirectories,
    // so this would fail when trying to write. But the path itself
    // is valid (doesn't escape the memory directory)
    expect(() => {
      memoryFileExistsOnDisk(nestedFilename);
    }).not.toThrow();
  });

  test('should handle filenames without extensions', () => {
    const filename = 'README';

    createMemoryFileOnDisk(filename, 'content without extension');

    expect(memoryFileExistsOnDisk(filename)).toBe(true);
  });

  test('should handle filenames with multiple dots', () => {
    const filename = 'my.file.name.md';

    createMemoryFileOnDisk(filename, '# Multiple dots');

    expect(memoryFileExistsOnDisk(filename)).toBe(true);
  });
});

test.describe('Context Fixture Utilities', () => {
  test.beforeEach(() => {
    resetContextDirectory();
  });

  test.afterEach(() => {
    resetContextDirectory();
  });

  test('should create and detect a valid context file', () => {
    const filename = 'test-context.md';
    const content = '# Test Context Content';

    createContextFileOnDisk(filename, content);

    expect(contextFileExistsOnDisk(filename)).toBe(true);
  });

  test('should return false for non-existent context file', () => {
    expect(contextFileExistsOnDisk('non-existent.md')).toBe(false);
  });

  test('should reject path traversal attempt with ../ for context files', () => {
    const maliciousFilename = '../../../etc/passwd';

    expect(() => {
      createContextFileOnDisk(maliciousFilename, 'malicious content');
    }).toThrow('Invalid context filename');

    expect(() => {
      contextFileExistsOnDisk(maliciousFilename);
    }).toThrow('Invalid context filename');
  });

  test('should reject absolute path attempt for context files', () => {
    const maliciousFilename = '/etc/passwd';

    expect(() => {
      createContextFileOnDisk(maliciousFilename, 'malicious content');
    }).toThrow('Invalid context filename');

    expect(() => {
      contextFileExistsOnDisk(maliciousFilename);
    }).toThrow('Invalid context filename');
  });

  test('should accept nested paths within context directory', () => {
    const nestedFilename = 'subfolder/nested-file.md';

    // The path itself is valid (doesn't escape the context directory)
    expect(() => {
      contextFileExistsOnDisk(nestedFilename);
    }).not.toThrow();
  });

  test('should handle filenames without extensions for context', () => {
    const filename = 'README';

    createContextFileOnDisk(filename, 'content without extension');

    expect(contextFileExistsOnDisk(filename)).toBe(true);
  });

  test('should handle filenames with multiple dots for context', () => {
    const filename = 'my.context.file.md';

    createContextFileOnDisk(filename, '# Multiple dots');

    expect(contextFileExistsOnDisk(filename)).toBe(true);
  });
});
