import { describe, expect, it } from 'vitest';
import { mergeIntoBody } from '../src/report/pr.js';
import { markdownLines, type Report } from '../src/report/report.js';

const report: Report = {
  tool: 'ld-e2e', version: '0.1.0', target: 'prestashop', baseUrl: 'http://localhost:8080',
  receivingAccount: 'rRecv', network: 'testnet', startedAt: '2026-09-23T12:00:00.000Z',
  results: [
    { id: 'PS-05', title: 'Settled', target: 'prestashop', outcome: 'pass', startedAt: '2026-09-23T12:01:00.000Z', durationMs: 20000, states: ['settled'],
      evidence: [{ kind: 'order', text: 'order ABC (#12), page shows 0.5 XRP to rRecv tag 7, state waiting' }, { kind: 'tx', text: 'sent', hash: 'DEADBEEF01234567', explorer: 'https://testnet.xrpl.org/transactions/DEADBEEF01234567' }] },
    { id: 'PS-03', title: 'Partial, then topped up', target: 'prestashop', outcome: 'fail', reason: 'timed out', startedAt: '2026-09-23T12:02:00.000Z', durationMs: 1000, states: ['partial'], evidence: [] },
  ],
};

const body = `## What

Things.

## Manual end-to-end tests

- [ ] PS-05 Settled — send the exact amount
- [ ] PS-01 Waiting — nothing sent
- [ ] Guest order can poll (no ID, must stay)

## Notes

Keep me.`;

describe('mergeIntoBody', () => {
  it('ticks passed cases, keeps failed ones open, leaves other lines alone', () => {
    const merged = mergeIntoBody(body, report);
    expect(merged.replaced).toEqual(['PS-05']);
    expect(merged.missing).toEqual(['PS-03']);
    expect(merged.body).toContain('- [x] PS-05 Settled — order ABC; tx [`DEADBEEF…`](https://testnet.xrpl.org/transactions/DEADBEEF01234567)');
    expect(merged.body).toContain('- [ ] PS-03 Partial, then topped up — states partial; **failed:** timed out');
    expect(merged.body).toContain('- [ ] PS-01 Waiting — nothing sent');
    expect(merged.body).toContain('- [ ] Guest order can poll (no ID, must stay)');
    expect(merged.body).toContain('## Notes\n\nKeep me.');
  });

  it('adds missing cases inside the section, before the next heading', () => {
    const merged = mergeIntoBody(body, report);
    const section = merged.body.slice(merged.body.indexOf('## Manual'), merged.body.indexOf('## Notes'));
    expect(section).toContain('PS-03');
  });

  it('is idempotent: a second merge replaces its own lines', () => {
    const once = mergeIntoBody(body, report).body;
    const twice = mergeIntoBody(once, report).body;
    expect(twice).toBe(once);
  });

  it('appends a section when the PR has none', () => {
    const merged = mergeIntoBody('## What\n\nThings.', report);
    expect(merged.body).toContain('## Manual end-to-end tests');
    expect(merged.body).toContain('- [x] PS-05');
  });

  it('never carries a seed into a line', () => {
    for (const line of markdownLines(report).values()) expect(line).not.toMatch(/\bs[1-9A-HJ-NP-Za-km-z]{25,35}\b/);
  });
});
