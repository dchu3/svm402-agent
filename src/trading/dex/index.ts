import type { DexAdapter } from '../types.js';

export interface DexRegistry {
  register(name: string, adapter: DexAdapter): void;
  get(name: string): DexAdapter | undefined;
  list(): string[];
}

export function createDexRegistry(): DexRegistry {
  const adapters = new Map<string, DexAdapter>();
  return {
    register(name, adapter) {
      adapters.set(name.toLowerCase(), adapter);
    },
    get(name) {
      return adapters.get(name.toLowerCase());
    },
    list() {
      return [...adapters.keys()];
    },
  };
}
