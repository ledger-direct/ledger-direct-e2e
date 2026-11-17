import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findCase } from '../cases/catalogue.js';
import { markdownLines, type Report } from './report.js';

const run = promisify(execFile);

const SECTION = /^##+\s+manual end-to-end tests\s*$/im;

/**
 * Writes results into a pull request's "Manual end-to-end tests" section.
 *
 * Only lines that are the harness's to fill are touched: a placeholder (`- [ ] PS-05`, or
 * with the case's title, `- [ ] PS-05 Settled — send the exact amount`) and a line this tool
 * wrote before. A line that starts with a case ID but says something else
 * (`- [ ] PS-14 below the base reserve …`) is a check of its own and stays;
 * the report's line for that case is added next to it. Skipped cases are left out — a case
 * that does not exist on the platform is no open item. Free-text items, other sections and
 * everything else stay as they are, and a second run replaces its own lines rather than
 * appending. Runs as the caller's GitHub identity via gh.
 */
export function mergeIntoBody(body: string, report: Report): { body: string; replaced: string[]; missing: string[] } {
  const lines = markdownLines({ ...report, results: report.results.filter((r) => r.outcome !== 'skip') });
  const replaced: string[] = [];
  const seen = new Set<string>();
  const sectionStart = body.search(SECTION);
  if (sectionStart === -1) {
    // No section yet: append one.
    const appended = body.trimEnd() + '\n\n## Manual end-to-end tests\n\n' + [...lines.values()].join('\n') + '\n';
    return { body: appended, replaced: [], missing: [] };
  }
  const out = body.split('\n').map((line, index) => {
    if (index < body.slice(0, sectionStart).split('\n').length - 1) return line;
    const m = line.match(/^\s*-\s*\[[ xX]\]\s*(PS-\d{2})\b/);
    if (!m) return line;
    const id = m[1].toUpperCase();
    const replacement = lines.get(id);
    if (!replacement || !isHarnessLine(line.slice(m[0].length), id)) return line;
    seen.add(id);
    replaced.push(id);
    return replacement;
  });
  const missing = [...lines.keys()].filter((id) => !seen.has(id));
  let text = out.join('\n');
  if (missing.length > 0) {
    // Cases the PR did not list yet: add them at the end of the section.
    const sectionEnd = findSectionEnd(text, text.search(SECTION));
    text = text.slice(0, sectionEnd).trimEnd() + '\n' + missing.map((id) => lines.get(id)!).join('\n') + '\n\n' + text.slice(sectionEnd);
  }
  return { body: text, replaced, missing };
}

/**
 * What follows the case ID: nothing, or the case's title — alone or followed by what to do
 * (`PS-05 Settled — send the exact amount`), the form a PR template lists the cases in; a
 * row this tool wrote starts with the title too.
 */
function isHarnessLine(rest: string, id: string): boolean {
  const text = rest.trim().toLowerCase();
  const title = (findCase(id)?.title ?? '').toLowerCase();
  if (text === '') return true;
  if (title === '' || !text.startsWith(title)) return false;
  const after = text.slice(title.length);
  return after === '' || /^\s*[—–:-]/.test(after);
}

function findSectionEnd(text: string, sectionStart: number): number {
  const afterHeading = text.indexOf('\n', sectionStart) + 1;
  const next = text.slice(afterHeading).search(/^##+\s/m);
  return next === -1 ? text.length : afterHeading + next;
}

export async function readPrBody(repo: string, number: number): Promise<string> {
  const { stdout } = await run('gh', ['pr', 'view', String(number), '--repo', repo, '--json', 'body', '-q', '.body']);
  return stdout.replace(/\n$/, '');
}

export async function writePrBody(repo: string, number: number, body: string): Promise<void> {
  await run('gh', ['pr', 'edit', String(number), '--repo', repo, '--body', body]);
}
