import { assertHash, assertRef, DiffPreview, DiffPreviewLine, FileStatLike, parseDiffPreview, parseDiffTreeRawNumstat } from './gitUtils';
import { t } from '../i18n';

export type ComparisonMode = 'pr' | 'direct';
export type ComparisonLocation = 'editor' | 'panel';

/** A read-only comparison frozen at two commits; labels never replace its hashes. */
export interface ComparisonSnapshot {
    source: string;
    target: string;
    sourceHash: string;
    targetHash: string;
    /** PR: unique merge base; direct: targetHash. This is always the left side. */
    baseHash: string;
    mode: ComparisonMode;
    files: FileStatLike[];
    added: number;
    deleted: number;
    ahead: number;
    behind: number;
}

export type ComparisonRun = (args: string[]) => Promise<string>;

/** A single aligned display row. Hunk/metadata rows span both columns. */
export interface ComparisonSplitRow {
    note?: string;
    left?: { line?: number; text: string; changed: boolean };
    right?: { line?: number; text: string; changed: boolean };
}

/**
 * Align replacement blocks by their ordinal lines, padding the shorter side.
 * This is display alignment only, not a claim that paired lines are equivalent;
 * the original Git line numbers and text are preserved on their own sides.
 */
export function splitComparisonLines(lines: readonly DiffPreviewLine[]): ComparisonSplitRow[] {
    const rows: ComparisonSplitRow[] = [];
    let removed: DiffPreviewLine[] = [], added: DiffPreviewLine[] = [];
    const flush = () => {
        for (let i = 0; i < Math.max(removed.length, added.length); i++) {
            rows.push({
                left: removed[i] ? { line: removed[i].old, text: removed[i].text, changed: true } : undefined,
                right: added[i] ? { line: added[i].next, text: added[i].text, changed: true } : undefined
            });
        }
        removed = []; added = [];
    };
    for (const line of lines) {
        if (line.kind === 'del') {removed.push(line); continue;}
        if (line.kind === 'add') {added.push(line); continue;}
        flush();
        if (line.kind === 'context') {
            rows.push({ left: { line: line.old, text: line.text, changed: false },
                right: { line: line.next, text: line.text, changed: false } });
        } else {rows.push({ note: line.text });}
    }
    flush();
    return rows;
}

/** Read only a file in the trusted snapshot, including both paths for renames. */
export async function loadComparisonFile(run: ComparisonRun, snapshot: ComparisonSnapshot, filePath: string): Promise<DiffPreview> {
    const file = snapshot.files.find(item => item.path === filePath);
    if (!file) {throw new Error(t('comparison.fileNotInSnapshot'));}
    const patch = await run(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--unified=5',
        snapshot.baseHash, snapshot.sourceHash, '--', ...new Set([file.fromPath ?? file.path, file.path])]);
    return parseDiffPreview(patch, 2400);
}

/**
 * Resolve branch/tag/commit inputs once, then use immutable hashes for counting
 * and diffing. Fetching or checking out during a review cannot change its base.
 * No working-tree contents are read. Missing refs, unrelated histories in PR
 * mode, ambiguous merge bases and Git failures reject instead of returning [].
 */
export async function loadComparison(
    run: ComparisonRun, source: string, target: string, mode: ComparisonMode
): Promise<ComparisonSnapshot> {
    assertRef(source); assertRef(target);
    if (mode !== 'pr' && mode !== 'direct') {throw new Error(t('comparison.invalidMode'));}
    const [sourceHash, targetHash] = await Promise.all([source, target].map(async ref =>
        assertHash((await run(['rev-parse', '--verify', `${ref}^{commit}`])).trim())
    ));
    let baseHash = targetHash;
    if (mode === 'pr') {
        const bases = (await run(['merge-base', '--all', targetHash, sourceHash])).trim().split(/\s+/).filter(Boolean);
        if (bases.length !== 1) {throw new Error(t('comparison.ambiguousBase'));}
        baseHash = assertHash(bases[0]);
    }
    const [raw, counts] = await Promise.all([
        run(['diff', '--no-ext-diff', '--no-textconv', '-M', '--raw', '--numstat', '-z', baseHash, sourceHash, '--']),
        run(['rev-list', '--left-right', '--count', `${targetHash}...${sourceHash}`])
    ]);
    const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
    if (![behind, ahead].every(n => Number.isSafeInteger(n) && n >= 0)) {
        throw new Error(t('comparison.invalidCounts'));
    }
    const files = parseDiffTreeRawNumstat(raw)[0]?.files ?? [];
    return {
        source, target, sourceHash, targetHash, baseHash, mode, files, ahead, behind,
        added: files.reduce((sum, file) => sum + file.added, 0),
        deleted: files.reduce((sum, file) => sum + file.deleted, 0)
    };
}
