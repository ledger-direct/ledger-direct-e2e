import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Evidence } from '../runner/context.js';

export interface CaseResult {
  id: string;
  title: string;
  target: string;
  outcome: 'pass' | 'fail' | 'skip';
  reason?: string;
  startedAt: string;
  durationMs: number;
  states: string[];
  evidence: Evidence[];
}

export interface Report {
  tool: string;
  version: string;
  target: string;
  baseUrl: string;
  receivingAccount: string;
  network: 'testnet';
  startedAt: string;
  results: CaseResult[];
}

export async function writeReport(report: Report, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + '\n');
}

/** One checklist line per case, the way a PR's "Manual end-to-end tests" section reads. */
export function markdownLines(report: Report): Map<string, string> {
  const lines = new Map<string, string>();
  for (const r of report.results) {
    const box = r.outcome === 'pass' ? '[x]' : '[ ]';
    const order = r.evidence.find((e) => e.kind === 'order')?.text.match(/order (\S+) \(#(\d+)\)/);
    const hashes = r.evidence.filter((e) => e.kind === 'tx' && e.hash).map((e) => `[\`${e.hash!.slice(0, 8)}…\`](${e.explorer})`);
    const parts = [
      order ? `order ${order[1]}` : null,
      hashes.length ? `tx ${hashes.join(', ')}` : null,
      r.states.length ? `states ${r.states.join(' → ')}` : null,
      r.outcome === 'fail' ? `**failed:** ${r.reason ?? 'unknown'}` : null,
      `ld-e2e ${report.version} on ${report.target}, ${r.startedAt.slice(0, 16).replace('T', ' ')} UTC`,
    ].filter((p): p is string => p !== null);
    lines.set(r.id, `- ${box} ${r.id} ${r.title} — ${parts.join('; ')}`);
  }
  return lines;
}

export function markdown(report: Report): string {
  return [...markdownLines(report).values()].join('\n') + '\n';
}
