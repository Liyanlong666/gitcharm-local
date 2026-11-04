import { assertHash, assertRef, FileStatLike, parseDiffTreeRawNumstat } from './gitUtils';
import { t } from '../i18n';

export type ComparisonMode = 'pr' | 'direct';

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
