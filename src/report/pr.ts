import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { markdownLines, type Report } from './report.js';

const run = promisify(execFile);

const SECTION = /^##+\s+manual end-to-end tests\s*$/im;

/**
 * Writes results into a pull request's "Manual end-to-end tests" section.
 *
 * Only lines that start with a case ID are touched: `- [ ] PS-05 …` becomes
 * the report's line for PS-05. Free-text checklist items, other sections and
 * everything else in the body stay as they are, and a second run replaces its
 * own lines rather than appending. Runs as the caller's GitHub identity via gh.
 */
export function mergeIntoBody(body: string, report: Report): { body: string; replaced: string[]; missing: string[] } {
  const lines = markdownLines(report);
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
    if (!replacement) return line;
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
