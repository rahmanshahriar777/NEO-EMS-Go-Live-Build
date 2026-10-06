import { describe, it, expect } from 'vitest';
import tailwindConfig from '../../tailwind.config';

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return { r, g, b };
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

describe('Design System & Visual Regression Token Verification', () => {
  const colors = tailwindConfig.theme?.extend?.colors as any;
  const surface = colors?.surface as Record<string, string>;

  it('verifies that the surface palette is NOT inverted (surface-50 is lightest, surface-950 is darkest)', () => {
    expect(surface).toBeDefined();
    expect(surface['50']).toBeDefined();
    expect(surface['950']).toBeDefined();

    const lum50 = relativeLuminance(surface['50']);
    const lum100 = relativeLuminance(surface['100']);
    const lum200 = relativeLuminance(surface['200']);
    const lum800 = relativeLuminance(surface['800']);
    const lum900 = relativeLuminance(surface['900']);
    const lum950 = relativeLuminance(surface['950']);

    // Lightest tokens must have high luminance (> 0.85)
    expect(lum50).toBeGreaterThan(0.85);
    expect(lum100).toBeGreaterThan(0.8);

    // Monotonic darkening from 50 to 950
    expect(lum50).toBeGreaterThan(lum100);
    expect(lum100).toBeGreaterThan(lum200);
    expect(lum200).toBeGreaterThan(lum800);
    expect(lum800).toBeGreaterThan(lum900);
    expect(lum900).toBeGreaterThan(lum950);

    // Darkest tokens must have low luminance (< 0.15)
    expect(lum950).toBeLessThan(0.15);
  });

  it('verifies dark mode strategy is class-based', () => {
    expect(tailwindConfig.darkMode).toBe('class');
  });

  it('verifies primary branding palette tokens', () => {
    const primary = colors?.primary as Record<string, string>;
    expect(primary).toBeDefined();
    expect(primary['500']).toBe('#6366f1');
    expect(primary.DEFAULT).toBe('#6366f1');
  });
});
