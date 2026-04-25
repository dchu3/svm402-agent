import { describe, it, expect } from 'vitest';
import { TOOL_DECLARATIONS } from '../src/oracle/tools.js';
import { TOOL_PRICES_USD } from '../src/oracle/handlers.js';

describe('TOOL_DECLARATIONS', () => {
  it('declares the four expected tools', () => {
    const names = TOOL_DECLARATIONS.map((d) => d.name).sort();
    expect(names).toEqual(['get_forensics', 'get_honeypot', 'get_market', 'get_report']);
  });

  it('every tool requires an address parameter', () => {
    for (const decl of TOOL_DECLARATIONS) {
      expect(decl.parameters).toBeDefined();
      const required = decl.parameters?.required ?? [];
      expect(required).toContain('address');
      expect(decl.parameters?.properties?.address).toBeDefined();
    }
  });

  it('every declared tool has a price', () => {
    for (const decl of TOOL_DECLARATIONS) {
      expect(TOOL_PRICES_USD[decl.name as string]).toBeGreaterThan(0);
    }
  });
});
