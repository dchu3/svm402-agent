import { describe, it, expect, beforeEach } from 'vitest';
import { renderBanner } from '../../src/ui/banner.js';
import { renderBalanceTable, renderReceiptsTable, renderSpendBar, renderHelp } from '../../src/ui/tables.js';
import { buildPrompt } from '../../src/ui/prompt.js';
import { resetThemeForTest } from '../../src/ui/theme.js';

function strip(s: string): string {
  // Strip ANSI escape sequences
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

beforeEach(() => {
  // Force ASCII + no color for stable assertions
  process.env.SVM402_ASCII = '1';
  process.env.NO_COLOR = '1';
  delete process.env.SVM402_PROMPT;
  resetThemeForTest();
});

describe('banner', () => {
  it('renders core fields', () => {
    const out = strip(
      renderBanner({
        oracleUrl: 'https://svm402.com',
        walletAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        provider: 'gemini', model: 'gemini-2.5-flash',
        spendCap: 0.1,
        usdcBalance: '1.234',
      }),
    );
    expect(out).toContain('svm402-agent');
    expect(out).toContain('https://svm402.com');
    expect(out).toContain('0xabcdef');
    expect(out).toContain('gemini-2.5-flash');
    expect(out).toContain('1.234');
    expect(out).toContain('$0.100');
    expect(out).toContain('Base mainnet');
  });

  it('shows low-balance warning when bal < 0.05', () => {
    const out = strip(
      renderBanner({
        oracleUrl: 'http://x',
        walletAddress: '0x' + '0'.repeat(40),
        provider: 'gemini', model: 'm',
        spendCap: 0.1,
        usdcBalance: '0.01',
      }),
    );
    expect(out).toContain('USDC balance is very low');
  });

  it('handles balance lookup failure', () => {
    const out = strip(
      renderBanner({
        oracleUrl: 'http://x',
        walletAddress: '0x' + '0'.repeat(40),
        provider: 'gemini', model: 'm',
        spendCap: 0.1,
        usdcBalance: null,
        balanceError: 'rpc timeout',
      }),
    );
    expect(out).toContain('rpc timeout');
  });
});

describe('balance table', () => {
  it('shows address chain and USDC', () => {
    const out = strip(
      renderBalanceTable({ address: '0xabc', usdcFormatted: '1.23' }),
    );
    expect(out).toContain('address');
    expect(out).toContain('0xabc');
    expect(out).toContain('Base mainnet (8453)');
    expect(out).toContain('1.23');
  });
});

describe('spend bar', () => {
  it('renders 0% bar', () => {
    const out = strip(renderSpendBar(0, 0.1));
    expect(out).toContain('$0.0000');
    expect(out).toContain('$0.100');
    expect(out).toContain('(0%)');
  });

  it('renders mid bar', () => {
    const out = strip(renderSpendBar(0.05, 0.1));
    expect(out).toContain('(50%)');
  });

  it('warns when cap reached', () => {
    const out = strip(renderSpendBar(0.1, 0.1));
    expect(out).toContain('(100%)');
    expect(out).toContain('cap reached');
  });
});

describe('receipts table', () => {
  it('handles empty receipts', () => {
    const out = strip(renderReceiptsTable([]));
    expect(out).toContain('no receipts yet');
  });

  it('lists receipts with totals', () => {
    const out = strip(
      renderReceiptsTable([
        {
          endpoint: '/api/v1/x402/base/token/0xabc/report',
          success: true,
          transaction: '0x' + 'a'.repeat(64),
          network: 'eip155:8453',
          amountAtomic: '30000',
        },
        {
          endpoint: '/api/v1/x402/base/token/0xdef/report',
          success: false,
          transaction: '',
          network: 'eip155:8453',
        },
      ]),
    );
    expect(out).toContain('report');
    expect(out).toContain('eip155:8453');
    expect(out).toContain('total:');
    expect(out).toContain('1 failed');
  });
});

describe('help', () => {
  it('lists slash commands and tools with prices', () => {
    const out = strip(renderHelp());
    expect(out).toContain('Slash commands');
    expect(out).toContain('/help');
    expect(out).toContain('/balance');
    expect(out).toContain('Tools available to Gemini');
    expect(out).not.toContain('get_market');
    expect(out).toContain('get_report');
    expect(out).toContain('$0.010');
  });
});

describe('prompt', () => {
  it('rich prompt embeds spend status', () => {
    const out = strip(buildPrompt({ spend: 0.015, cap: 0.1, receipts: 3 }));
    expect(out).toContain('$0.0150');
    expect(out).toContain('$0.100');
    expect(out).toContain('3 calls');
    expect(out).toContain('svm402');
  });

  it('plain prompt fallback', () => {
    process.env.SVM402_PROMPT = 'plain';
    resetThemeForTest();
    const out = buildPrompt({ spend: 0, cap: 0.1, receipts: 0 });
    expect(out).toBe('svm402> ');
  });

  it('singular call', () => {
    const out = strip(buildPrompt({ spend: 0, cap: 0.1, receipts: 1 }));
    expect(out).toContain('1 call');
    expect(out).not.toContain('1 calls');
  });
});
