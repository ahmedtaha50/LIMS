/**
 * Roadmap M10 (r1-results-oos), the screens: the result grid and the Certificate of Analysis read `isOos` (the column), so an OOS
 * result shows as OOS and the CoA says so. v0.1.0 read `r.isOOS`, which is always undefined: every OOS rendered PASS and the CoA
 * said ALL TESTS PASSED. Rendered on the server with react-dom (no browser), like tests/api/spec-ui.test.ts.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { coaCertification, ResultEvaluation } from '../../src/components/SampleDetail';

const oos = { id: 'r1', parameter: 'Assay', value: '90.0', isOos: true, limitKind: 'RANGE', lowerText: '98.0', upperText: '102.0', decimals: 1, unit: '%' };
const pass = { ...oos, id: 'r2', value: '99.0', isOos: false };
const empty = { ...oos, id: 'r3', value: null, isOos: false };

describe('the result grid', () => {
  it('shows an OOS badge for an OOS result and Pass for a passing one, and nothing judged for an empty one', () => {
    expect(renderToStaticMarkup(React.createElement(ResultEvaluation, { result: oos }))).toContain('OOS');
    const ok = renderToStaticMarkup(React.createElement(ResultEvaluation, { result: pass }));
    expect(ok).toContain('Pass');
    expect(ok).not.toContain('OOS');
    expect(renderToStaticMarkup(React.createElement(ResultEvaluation, { result: empty }))).toContain('Pending');
  });
});

describe('the Certificate of Analysis', () => {
  it('says CONTAINS OOS RESULTS when one result is OOS', () => {
    expect(coaCertification([pass, oos])).toEqual({ pass: false, text: 'CERTIFICATION OF RESULTS: CONTAINS OOS RESULTS' });
  });
  it('says ALL TESTS PASSED only when every result is entered and none is OOS', () => {
    expect(coaCertification([pass])).toEqual({ pass: true, text: 'CERTIFICATION OF RESULTS: ALL TESTS PASSED' });
    expect(coaCertification([pass, empty]).pass).toBe(false);
    expect(coaCertification([pass, empty]).text).toContain('INCOMPLETE');
  });
});

describe('no code reads the misspelt isOOS', () => {
  it('src/ has no .isOOS', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && /\bisOOS\b/.test(readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    walk(join(__dirname, '../../src'));
    expect(hits).toEqual([]);
  });
});
