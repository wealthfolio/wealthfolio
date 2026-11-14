import policy from "../../../../config/timeouts.json";

interface TimeoutBudget {
  serverMs: number;
  clientMs: number;
  proxyMs: number;
}

const profiles: Record<string, TimeoutBudget> = policy.profiles;

// Web fetches and every Tauri OS use the same command budget. The server reads
// this same checked-in policy, with room to return its error before the client.
export const invokeTimeoutMs = (command: string): number => {
  const rule = policy.rules.find((rule) => rule.commands.includes(command));
  return profiles[rule?.profile ?? "interactive"].clientMs;
};

export class InvokeTimeoutError extends Error {
  constructor(command: string) {
    super(`Command "${command}" timed out`);
    this.name = "TimeoutError";
  }
}
