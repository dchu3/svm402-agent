import { describe, it, expect } from 'vitest';
import { formatAtomicUsdc, parseAtomicUsdc, USDC_DECIMALS } from '../../src/util/usdc.js';

describe('USDC_DECIMALS', () => {
  it('is 6', () => {
    expect(USDC_DECIMALS).toBe(6);
  });
});

describe('formatAtomicUsdc', () => {
  it('returns dash for undefined', () => {
    expect(formatAtomicUsdc(undefined)).toBe('—');
  });

  it('returns dash for null', () => {
    expect(formatAtomicUsdc(null)).toBe('—');
  });

  it('returns dash for empty string', () => {
    expect(formatAtomicUsdc('')).toBe('—');
  });

  it('returns dash for non-numeric', () => {
    expect(formatAtomicUsdc('abc')).toBe('—');
  });

  it('formats zero', () => {
    expect(formatAtomicUsdc('0')).toBe('0');
  });

  it('formats 5000 atomic as 0.005', () => {
    expect(formatAtomicUsdc('5000')).toBe('0.005');
  });

  it('formats 1_000_000 atomic as 1', () => {
    expect(formatAtomicUsdc('1000000')).toBe('1');
  });

  it('formats 1_234_567 atomic as 1.234567', () => {
    expect(formatAtomicUsdc('1234567')).toBe('1.234567');
  });

  it('formats very large atomic without scientific notation', () => {
    expect(formatAtomicUsdc('1000000000000000000000000000')).toBe('1000000000000000000000');
  });

  it('rejects decimal strings', () => {
    expect(formatAtomicUsdc('1.5')).toBe('—');
  });

  it('handles negative atomic', () => {
    expect(formatAtomicUsdc('-5000')).toBe('-0.005');
  });
});

describe('parseAtomicUsdc', () => {
  it('returns undefined for missing values', () => {
    expect(parseAtomicUsdc(undefined)).toBeUndefined();
    expect(parseAtomicUsdc(null)).toBeUndefined();
    expect(parseAtomicUsdc('')).toBeUndefined();
    expect(parseAtomicUsdc('abc')).toBeUndefined();
  });

  it('parses atomic to USDC float', () => {
    expect(parseAtomicUsdc('5000')).toBeCloseTo(0.005, 10);
    expect(parseAtomicUsdc('1000000')).toBe(1);
  });
});
