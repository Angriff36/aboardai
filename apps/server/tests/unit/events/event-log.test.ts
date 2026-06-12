/**
 * EventLog writer/reader — unit tests (TDD)
 *
 * Uses os.tmpdir() for temp directories. ALLOWED_ROOT_DIRECTORY is NOT set in
 * the test environment so secureFs validates all paths as allowed.
 *
 * Fake-timer convention: vi.useFakeTimers() / vi.useRealTimers() bracketed in
 * beforeEach/afterEach to match the agent-executor.test.ts pattern.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { EventLogWriter, readEventLog } from '../../../src/events/event-log.js';
import type { NormalizedEvent } from '@aboardai/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a minimal NormalizedEvent of the given kind */
function makeEvent(
  kind: NormalizedEvent['kind'],
  overrides: Partial<NormalizedEvent> = {}
): NormalizedEvent {
  return {
    v: 1,
    id: '001',
    ts: new Date().toISOString(),
    kind,
    provider: 'claude',
    featureId: 'feat-test',
    ...overrides,
  };
}

/** Create a fresh temp directory, returns its path */
async function makeTempDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `event-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Compute the expected events.jsonl path */
function eventsJsonlPath(projectPath: string, featureId: string): string {
  return path.join(projectPath, '.aboardai', 'features', featureId, 'events.jsonl');
}

/** Read all lines from a jsonl file */
async function readLines(filePath: string): Promise<string[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  return content.split('\n').filter((l) => l.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Suite: debounced batching
// ---------------------------------------------------------------------------

describe('EventLogWriter — debounced batching', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('batches 3 appends, flushes after 150ms, then accepts 2 more after another 150ms (5 lines total)', async () => {
    const featureId = 'feat-debounce';
    const writer = new EventLogWriter({ projectPath: tmpDir, featureId });

    // Enqueue 3 events
    writer.append(makeEvent('agent_message', { id: '001', text: 'hello' }));
    writer.append(makeEvent('agent_message', { id: '002', text: 'world' }));
    writer.append(makeEvent('tool_use', { id: '003' }));

    // Advance past the 150ms debounce — advanceTimersByTimeAsync fires the timer
    // and then we need real I/O to complete; switch to real timers and await flush.
    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();
    await writer.waitForFlush();

    const filePath = eventsJsonlPath(tmpDir, featureId);
    const lines1 = await readLines(filePath);
    expect(lines1).toHaveLength(3);

    // Buffer should have been reset — append 2 more
    vi.useFakeTimers();
    writer.append(makeEvent('agent_message', { id: '004', text: 'after flush' }));
    writer.append(makeEvent('agent_message', { id: '005', text: 'second batch' }));

    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();
    await writer.waitForFlush();

    const lines2 = await readLines(filePath);
    expect(lines2).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Suite: force-flush on terminal events
// ---------------------------------------------------------------------------

describe('EventLogWriter — force-flush on terminal events', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('force-flushes immediately when appending a result event (no timer advance needed)', async () => {
    const featureId = 'feat-force-result';
    const writer = new EventLogWriter({ projectPath: tmpDir, featureId });

    writer.append(makeEvent('agent_message', { id: '001' }));
    writer.append(
      makeEvent('result', { id: '002', result: { subtype: 'success', isError: false } })
    );

    // Force-flush fires synchronously (no timer). Switch to real timers so the
    // async I/O can complete, then await the in-flight flush.
    vi.useRealTimers();
    await writer.waitForFlush();

    const filePath = eventsJsonlPath(tmpDir, featureId);
    const lines = await readLines(filePath);
    expect(lines).toHaveLength(2);
  });

  it('force-flushes immediately when appending an error event', async () => {
    const featureId = 'feat-force-error';
    const writer = new EventLogWriter({ projectPath: tmpDir, featureId });

    writer.append(makeEvent('agent_message', { id: '001' }));
    writer.append(makeEvent('error', { id: '002', text: 'something failed' }));

    vi.useRealTimers();
    await writer.waitForFlush();

    const filePath = eventsJsonlPath(tmpDir, featureId);
    const lines = await readLines(filePath);
    expect(lines).toHaveLength(2);
  });

  it('force-flushes immediately when appending a status(interrupted) event', async () => {
    const featureId = 'feat-force-interrupted';
    const writer = new EventLogWriter({ projectPath: tmpDir, featureId });

    writer.append(makeEvent('agent_message', { id: '001' }));
    writer.append(makeEvent('status', { id: '002', status: { status: 'interrupted' } }));

    vi.useRealTimers();
    await writer.waitForFlush();

    const filePath = eventsJsonlPath(tmpDir, featureId);
    const lines = await readLines(filePath);
    expect(lines).toHaveLength(2);
  });

  it('force-flushes immediately when appending a status(fatal) event', async () => {
    const featureId = 'feat-force-fatal';
    const writer = new EventLogWriter({ projectPath: tmpDir, featureId });

    writer.append(makeEvent('agent_message', { id: '001' }));
    writer.append(makeEvent('status', { id: '002', status: { status: 'fatal' } }));

    vi.useRealTimers();
    await writer.waitForFlush();

    const filePath = eventsJsonlPath(tmpDir, featureId);
    const lines = await readLines(filePath);
    expect(lines).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Suite: close() flushes pending and prevents further appends
// ---------------------------------------------------------------------------

describe('EventLogWriter — close()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('close() flushes any pending lines without advancing timers', async () => {
    const featureId = 'feat-close-flush';
    const writer = new EventLogWriter({ projectPath: tmpDir, featureId });

    writer.append(makeEvent('agent_message', { id: '001', text: 'pending line' }));

    // close() must flush before timer fires
    vi.useRealTimers();
    await writer.close();

    const filePath = eventsJsonlPath(tmpDir, featureId);
    const lines = await readLines(filePath);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]) as NormalizedEvent;
    expect(parsed.id).toBe('001');
    expect(parsed.text).toBe('pending line');
  });

  it('append after close() is silently dropped (warn+drop behavior)', async () => {
    const featureId = 'feat-close-drop';
    const writer = new EventLogWriter({ projectPath: tmpDir, featureId });

    writer.append(makeEvent('agent_message', { id: '001' }));

    vi.useRealTimers();
    await writer.close();

    // This append should be silently dropped (no throw)
    expect(() => writer.append(makeEvent('agent_message', { id: '002' }))).not.toThrow();

    // Advance timers to ensure the dropped event isn't queued
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(300);
    vi.useRealTimers();

    const filePath = eventsJsonlPath(tmpDir, featureId);
    const lines = await readLines(filePath);
    // Only the original line, not the post-close one
    expect(lines).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Suite: readEventLog — torn-tail tolerance
// ---------------------------------------------------------------------------

describe('readEventLog — torn-tail tolerance', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns [] when events.jsonl does not exist', async () => {
    const events = await readEventLog(tmpDir, 'feat-missing');
    expect(events).toEqual([]);
  });

  it('skips a torn/partial final line and returns only valid lines (no throw)', async () => {
    const featureId = 'feat-torn';
    const dir = path.join(tmpDir, '.aboardai', 'features', featureId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'events.jsonl');

    const good1 = makeEvent('agent_message', { id: '001', text: 'first' });
    const good2 = makeEvent('agent_message', { id: '002', text: 'second' });
    const torn =
      '{"v":1,"id":"003","ts":"2026-01-01T00:00:00.000Z","kind":"agent_message","provider":"claude","partial{'; // truncated

    await fs.writeFile(
      filePath,
      `${JSON.stringify(good1)}\n${JSON.stringify(good2)}\n${torn}`,
      'utf-8'
    );

    const events = await readEventLog(tmpDir, featureId);
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe('001');
    expect(events[1].id).toBe('002');
  });

  it('skips lines with v !== 1 and continues parsing remaining lines', async () => {
    const featureId = 'feat-version-mismatch';
    const dir = path.join(tmpDir, '.aboardai', 'features', featureId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'events.jsonl');

    const good = makeEvent('agent_message', { id: '001', text: 'valid' });
    const wrongVersion = { ...makeEvent('agent_message', { id: '002' }), v: 2 };
    const good2 = makeEvent('result', { id: '003', result: { isError: false } });

    await fs.writeFile(
      filePath,
      `${JSON.stringify(good)}\n${JSON.stringify(wrongVersion)}\n${JSON.stringify(good2)}\n`,
      'utf-8'
    );

    const events = await readEventLog(tmpDir, featureId);
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe('001');
    expect(events[1].id).toBe('003');
  });

  it('skips completely unparseable lines without throwing', async () => {
    const featureId = 'feat-unparseable';
    const dir = path.join(tmpDir, '.aboardai', 'features', featureId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'events.jsonl');

    const good = makeEvent('agent_message', { id: '001', text: 'ok' });
    await fs.writeFile(filePath, `${JSON.stringify(good)}\nnot json at all\n`, 'utf-8');

    const events = await readEventLog(tmpDir, featureId);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('001');
  });
});

// ---------------------------------------------------------------------------
// Suite: concurrent-feature isolation
// ---------------------------------------------------------------------------

describe('EventLogWriter — concurrent-feature isolation', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('two writers with different featureIds write to isolated files', async () => {
    const featureA = 'feat-isolation-a';
    const featureB = 'feat-isolation-b';

    const writerA = new EventLogWriter({ projectPath: tmpDir, featureId: featureA });
    const writerB = new EventLogWriter({ projectPath: tmpDir, featureId: featureB });

    writerA.append(makeEvent('agent_message', { id: 'a-001', text: 'from A' }));
    writerB.append(makeEvent('agent_message', { id: 'b-001', text: 'from B' }));
    writerA.append(makeEvent('result', { id: 'a-002', result: { isError: false } }));
    writerB.append(makeEvent('result', { id: 'b-002', result: { isError: false } }));

    // Both trigger force-flush via result events
    await writerA.close();
    await writerB.close();

    const eventsA = await readEventLog(tmpDir, featureA);
    const eventsB = await readEventLog(tmpDir, featureB);

    expect(eventsA).toHaveLength(2);
    expect(eventsB).toHaveLength(2);

    // No cross-contamination
    expect(eventsA.every((e) => e.id.startsWith('a-'))).toBe(true);
    expect(eventsB.every((e) => e.id.startsWith('b-'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite: file structure (JSON lines parseable)
// ---------------------------------------------------------------------------

describe('EventLogWriter — file format', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('each line is a valid JSON-serialized NormalizedEvent', async () => {
    const featureId = 'feat-format';
    const writer = new EventLogWriter({ projectPath: tmpDir, featureId });

    const evt = makeEvent('agent_message', { id: '001', text: 'hello world' });
    writer.append(evt);
    await writer.close();

    const filePath = eventsJsonlPath(tmpDir, featureId);
    const lines = await readLines(filePath);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]) as NormalizedEvent;
    expect(parsed.v).toBe(1);
    expect(parsed.kind).toBe('agent_message');
    expect(parsed.text).toBe('hello world');
  });

  it('creates the directory on first flush (mkdir recursive)', async () => {
    const featureId = 'feat-mkdir';
    // The feature dir should NOT exist yet
    const expectedDir = path.join(tmpDir, '.aboardai', 'features', featureId);
    expect(fsSync.existsSync(expectedDir)).toBe(false);

    const writer = new EventLogWriter({ projectPath: tmpDir, featureId });
    writer.append(makeEvent('result', { id: '001', result: { isError: false } }));
    await writer.close();

    expect(fsSync.existsSync(expectedDir)).toBe(true);
    const filePath = path.join(expectedDir, 'events.jsonl');
    const lines = await readLines(filePath);
    expect(lines).toHaveLength(1);
  });
});
