import { describe, expect, it } from 'vitest';
import { mapHeaders, parseDate, parseStatus } from '../src/services/excel';
import { matchImages } from '../src/services/docx';
import { canonicalJson } from '../src/lib/crypto';
import { signLocal, verifyLocal } from '../src/storage';

describe('excel helpers', () => {
  it('maps headers case-insensitively, with aliases', () => {
    const m = mapHeaders(['ID', 'module', 'Title', 'Expected result', 'Tested by and date', 'Status']);
    expect(m).toMatchObject({ caseKey: 0, module: 1, title: 2, expected: 3, tester: 4, date: 4, status: 5 });
  });
  it('parses statuses and dates', () => {
    expect(parseStatus('pass')).toBe('PASS');
    expect(parseStatus('Not run')).toBe('NOT_RUN');
    expect(parseStatus('Blocked ')).toBe('BLOCKED');
    expect(parseStatus('maybe')).toBeNull();
    expect(parseDate('25-11-2026')?.toISOString()).toBe('2026-11-25T06:30:00.000Z');
    expect(parseDate('Ravi 25/11/2026 14:05')?.toISOString()).toBe('2026-11-25T08:35:00.000Z');
  });
});

describe('docx matching', () => {
  it('matches images to the nearest case ID before them', () => {
    const xml =
      '<w:p><w:r><w:t>Intro</w:t></w:r></w:p><w:p><w:r><w:drawing r:embed="rId1"/></w:r></w:p>' +
      '<w:p><w:r><w:t>VV-</w:t></w:r><w:r><w:t>001 login</w:t></w:r></w:p><w:p><w:drawing r:embed="rId2"/></w:p>' +
      '<w:p><w:r><w:t>Case VV-002</w:t></w:r></w:p><w:p><w:drawing r:embed="rId3"/><w:drawing r:embed="rId4"/></w:p>';
    const rels = new Map([['rId1', 'media/a.png'], ['rId2', 'media/b.png'], ['rId3', 'media/c.png'], ['rId4', 'media/d.png']]);
    const out = matchImages(xml, rels, /\bVV-\d{3}\b/gi);
    expect(out.map((x) => x.caseKey)).toEqual(['VV-001', 'VV-001', 'VV-002', 'VV-002']);
  });
});

describe('crypto helpers', () => {
  it('canonical JSON is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });
  it('local signed URLs verify and expire', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    expect(verifyLocal('view', 'k/a.png', exp, signLocal('view', 'k/a.png', exp))).toBe(true);
    expect(verifyLocal('up', 'k/a.png', exp, signLocal('view', 'k/a.png', exp))).toBe(false);
    expect(verifyLocal('view', 'k/a.png', 10, signLocal('view', 'k/a.png', 10))).toBe(false);
  });
});
