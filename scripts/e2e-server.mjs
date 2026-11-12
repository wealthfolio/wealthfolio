import { execFileSync } from "node:child_process";
import { once } from "node:events";

const descendantsOf = (pid) => {
  let table;
  try {
    table = execFileSync("ps", ["-A", "-o", "pid=", "-o", "ppid="], { encoding: "utf8" });
  } catch {
    // Without `ps`, stop only the direct child, as before.
    return [];
  }
  const childrenOf = new Map();
  for (const line of table.split("\n")) {
    if (!line.trim()) continue;
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child]);
  }
  const descendants = [];
  const queue = [pid];
  while (queue.length > 0) {
    for (const child of childrenOf.get(queue.shift()) ?? []) {
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
};

// Signals the server and, on Linux and macOS, every process under it.
// Signalling only the direct child can leave the runner waiting forever: a pnpm
// that hands off to the `packageManager` version waits for it synchronously and
// doesn't pass the signal on (pnpm/pnpm#9948).
export const stopServer = async (server, signal) => {
  if (server.exitCode !== null || server.signalCode !== null) {
    return;
  }
  const exited = once(server, "exit");
  const descendants = process.platform === "win32" ? [] : descendantsOf(server.pid);
  server.kill(signal);
  for (const pid of descendants) {
    try {
      process.kill(pid, signal);
    } catch {
      // It exited after `ps` listed it.
    }
  }
  await exited;
};
