export interface WatchlistEntry {
  address: string;
  symbol: string | null;
  name: string | null;
  score: number;
  reasoning: string | null;
  reportJson: string;
  addedAt: number;
  updatedAt: number;
}

export interface WatchlistEntryInput {
  address: string;
  symbol?: string | null;
  name?: string | null;
  score: number;
  reasoning?: string | null;
  report: unknown;
}

export interface ScanRunRecord {
  startedAt: number;
  finishedAt?: number;
  candidates?: number;
  added?: number;
  removed?: number;
  error?: string;
}
