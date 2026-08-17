/**
 * Port management utilities
 *
 * Functions for checking port availability and finding open ports.
 * No Electron dependencies - pure utility module.
 */

import net from 'net';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Check if a port is available
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });
    // Use Node's default binding semantics (matches most dev servers)
    // This avoids false-positives when a port is taken on IPv6/dual-stack.
    server.listen(port);
  });
}

/**
 * Find an available port starting from the preferred port
 * Tries up to 100 ports in sequence
 */
export async function findAvailablePort(preferredPort: number): Promise<number> {
  for (let offset = 0; offset < 100; offset++) {
    const port = preferredPort + offset;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`Could not find an available port starting from ${preferredPort}`);
}

/**
 * Find the PID(s) of processes LISTENING on a given TCP port (cross-platform).
 * Returns an empty array on any error or when nothing is listening.
 */
export async function getPidsOnPort(port: number): Promise<number[]> {
  try {
    if (process.platform === 'win32') {
      // netstat columns: Proto  Local Address  Foreign Address  State  PID
      const { stdout } = await execAsync('netstat -ano -p tcp');
      const pids = new Set<number>();
      for (const line of stdout.split('\n')) {
        if (!/LISTENING/i.test(line)) continue;
        const cols = line.trim().split(/\s+/);
        const local = cols[1] ?? '';
        // Match :PORT at the end of the local address (handles IPv4 and IPv6 forms)
        if (local.endsWith(`:${port}`)) {
          const pid = Number(cols[cols.length - 1]);
          if (Number.isInteger(pid) && pid > 0) pids.add(pid);
        }
      }
      return [...pids];
    }
    // macOS / Linux
    const { stdout } = await execAsync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`);
    return stdout
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Best-effort kill of a PID (and its child tree on Windows).
 */
async function killPid(pid: number): Promise<void> {
  try {
    if (process.platform === 'win32') {
      await execAsync(`taskkill /f /t /pid ${pid}`);
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // best-effort — the process may have already exited
  }
}

/**
 * Reclaim a RESERVED AboardAI port.
 *
 * If the canonical port is free, returns it unchanged. If a *previous* AboardAI
 * server (a zombie `tsx watch`/node child from a crash, or a stray `dev:web`) is
 * still holding it, kill that process and reuse the canonical port instead of
 * silently shifting to port+1 — which was the source of the "something on 3008,
 * now using 3009" confusion.
 *
 * SAFETY: only call this for ports that belong exclusively to AboardAI
 * (see RESERVED_PORTS). Anything occupying them is by definition a leftover of
 * ours. Falls back to findAvailablePort() if the holder can't be killed.
 */
export async function reclaimPort(port: number): Promise<number> {
  if (await isPortAvailable(port)) return port;

  const pids = await getPidsOnPort(port);
  for (const pid of pids) {
    if (pid === process.pid) continue; // never kill ourselves
    await killPid(pid);
  }

  // Give the OS a moment to release the listening socket (up to ~2s)
  for (let i = 0; i < 10; i++) {
    if (await isPortAvailable(port)) return port;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Could not reclaim (e.g. unkillable owner) — fall back to the next free port
  return findAvailablePort(port);
}
