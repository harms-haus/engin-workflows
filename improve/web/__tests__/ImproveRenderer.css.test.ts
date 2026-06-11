/**
 * Tests for ImproveRenderer.css.
 *
 * Verifies that the CSS file defines the expected class names
 * .improve-renderer and .improve-content with the correct styles,
 * and does NOT contain any .develop-renderer or .develop-content classes.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const cssPath = resolve(__dirname, '..', 'ImproveRenderer.css');

function readCss(): string {
  return readFileSync(cssPath, 'utf-8');
}

describe('ImproveRenderer.css', () => {
  it('defines the .improve-renderer class', () => {
    const css = readCss();
    expect(css).toContain('.improve-renderer');
  });

  it('defines the .improve-content class', () => {
    const css = readCss();
    expect(css).toContain('.improve-content');
  });

  it('does NOT contain .develop-renderer class', () => {
    const css = readCss();
    expect(css).not.toContain('.develop-renderer');
  });

  it('does NOT contain .develop-content class', () => {
    const css = readCss();
    expect(css).not.toContain('.develop-content');
  });

  it('sets display: flex on .improve-renderer', () => {
    const css = readCss();
    expect(css).toMatch(/\.improve-renderer\s*\{[^}]*display:\s*flex/);
  });

  it('sets flex-direction: column on .improve-renderer', () => {
    const css = readCss();
    expect(css).toMatch(/\.improve-renderer\s*\{[^}]*flex-direction:\s*column/);
  });

  it('sets height: 100% on .improve-renderer', () => {
    const css = readCss();
    expect(css).toMatch(/\.improve-renderer\s*\{[^}]*height:\s*100%/);
  });

  it('sets overflow: hidden on .improve-renderer', () => {
    const css = readCss();
    expect(css).toMatch(/\.improve-renderer\s*\{[^}]*overflow:\s*hidden/);
  });

  it('sets flex: 1 on .improve-content', () => {
    const css = readCss();
    expect(css).toMatch(/\.improve-content\s*\{[^}]*flex:\s*1/);
  });

  it('sets display: flex on .improve-content', () => {
    const css = readCss();
    expect(css).toMatch(/\.improve-content\s*\{[^}]*display:\s*flex/);
  });

  it('sets flex-direction: column on .improve-content', () => {
    const css = readCss();
    expect(css).toMatch(/\.improve-content\s*\{[^}]*flex-direction:\s*column/);
  });

  it('sets overflow: hidden on .improve-content', () => {
    const css = readCss();
    expect(css).toMatch(/\.improve-content\s*\{[^}]*overflow:\s*hidden/);
  });
});
