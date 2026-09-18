import { readFileSync } from "node:fs";
import type { Config } from "./config.js";

export interface Entry {
  date: Date;
  cents: number;
  category: string;
  note?: string;
}

export type Section = "essentials" | "lifestyle" | "other";

export const ALIASES: Record<string, string> = {
  groceries: "food",
  bus: "transport",
};

export class Ledger {
  private entries: Entry[] = [];
  private keys = new Set<string>();

  add(entry: Entry): boolean {
    const key = `${entry.date.toISOString()}|${entry.cents}|${entry.category}|${entry.note ?? ""}`;
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    this.entries.push(entry);
    return true;
  }

  total(category?: string): number {
    return this.entries.filter((e) => !category || e.category === category).reduce((a, e) => a + e.cents, 0);
  }
}

export function formatMoney(cents: number, config?: Config): string {
  if (config) return new Intl.NumberFormat(config.locale, { style: "currency", currency: config.currency }).format(cents / 100);
  return (cents / 100).toFixed(2);
}

export default function loadConfig(path: string): Config {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { currency: "USD", locale: "en-US" };
  }
}
