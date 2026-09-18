import fs from "fs/promises";
import path from "path";
import { getStorageRoot } from "./storage";

export type LinkedInPendingDraft = {
  text: string;
  chatId: number;
  createdAt: string;
  revision: number;
};

export type LinkedInState = {
  nextPostAt: string | null;
  lastPostAt: string | null;
  nextFollowCheckAt: string | null;
  lastFollowAt: string | null;
  lastFollowDay: string | null;
  connectedProfiles: string[];
  pendingDraft: LinkedInPendingDraft | null;
};

const DEFAULT_STATE: LinkedInState = {
  nextPostAt: null,
  lastPostAt: null,
  nextFollowCheckAt: null,
  lastFollowAt: null,
  lastFollowDay: null,
  connectedProfiles: [],
  pendingDraft: null,
};

function statePath(): string {
  return path.join(getStorageRoot(), "linkedin-state.json");
}

export async function loadLinkedInState(): Promise<LinkedInState> {
  try {
    const raw = await fs.readFile(statePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<LinkedInState>;
    return {
      ...DEFAULT_STATE,
      ...parsed,
      connectedProfiles: Array.isArray(parsed.connectedProfiles)
        ? parsed.connectedProfiles
        : [],
      pendingDraft: parsed.pendingDraft ?? null,
    };
  } catch {
    return { ...DEFAULT_STATE, connectedProfiles: [] };
  }
}

export async function saveLinkedInState(state: LinkedInState): Promise<void> {
  const dir = path.dirname(statePath());
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(statePath(), JSON.stringify(state, null, 2), "utf8");
}

/** Uniform 1..max inclusive; mean of 1..5 is 3. */
export function randomIntInclusive(min: number, max: number): number {
  const a = Math.min(min, max);
  const b = Math.max(min, max);
  return a + Math.floor(Math.random() * (b - a + 1));
}

export function addDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function randomDelayMs(minMs: number, maxMs: number): number {
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
