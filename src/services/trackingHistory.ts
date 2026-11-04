import { t } from '../i18n';
import { assertRef } from './gitUtils';

export type TrackingStatus = 'synced' | 'ahead' | 'behind' | 'diverged' | 'noUpstream' | 'missingUpstream' | 'detached';

/** One immutable local/upstream snapshot: counts and graph roots describe the same commits. */
export interface TrackingHistory {
    branch: string;
    upstream?: string;
    revisions: string[];
    ahead: number;
    behind: number;
    status: TrackingStatus;
}

/** Only read-only git plumbing is used; an absent upstream is never guessed from origin/name. */
export async function loadTrackingHistory(
    run: (args: string[]) => Promise<string>, selectedLocalBranch?: string
): Promise<TrackingHistory> {
    const branch = selectedLocalBranch ?? await run(['symbolic-ref', '--quiet', '--short', 'HEAD']).then(s => s.trim()).catch(() => '');
    if (!branch) {
        const head = (await run(['rev-parse', '--verify', 'HEAD'])).trim();
        return { branch: '', revisions: [head], ahead: 0, behind: 0, status: 'detached' };
    }
    assertRef(branch);
    const localRef = `refs/heads/${branch}`;
    const records = (await run(['for-each-ref', localRef, '--format=%(refname)%00%(objectname)%00%(upstream)'])).trim().split('\n');
    // for-each-ref also matches descendants; only the exact selected branch is valid.
    const record = records.map(s => s.split('\0')).find(parts => parts[0] === localRef);
    if (!record?.[1]) {throw new Error(t('history.branchGone', { name: branch }));}
    const localHash = record[1];
    const upstreamRef = record[2];
    if (!upstreamRef) {
        return { branch, revisions: [localHash], ahead: 0, behind: 0, status: 'noUpstream' };
    }
    assertRef(upstreamRef);
    const upstream = upstreamRef.replace(/^refs\/(remotes|heads)\//, '');
    const remoteHash = await run(['rev-parse', '--verify', '--quiet', `${upstreamRef}^{commit}`]).then(s => s.trim()).catch(() => '');
    if (!remoteHash) {
        return { branch, upstream, revisions: [localHash], ahead: 0, behind: 0, status: 'missingUpstream' };
    }
    const count = (await run(['rev-list', '--left-right', '--count', `${localHash}...${remoteHash}`])).trim();
    if (!/^\d+\s+\d+$/.test(count)) {throw new Error(t('history.invalidCounts'));}
    const [ahead, behind] = count.split(/\s+/).map(Number);
    const status: TrackingStatus = ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'synced';
    return { branch, upstream, revisions: [...new Set([localHash, remoteHash])], ahead, behind, status };
}

/** Resolve a selected remote to its configured local tracker, never by equal branch names. */
export function trackingLocalForSelection(
    current: string, locals: Array<{ name: string; upstream?: string }>, selected?: string
): string | undefined {
    if (!selected) {return current || undefined;}
    if (locals.some(branch => branch.name === selected)) {return selected;}
    const matches = locals.filter(branch => branch.upstream === selected);
    // Prefer the checked-out tracker; otherwise only an unambiguous match is usable.
    return matches.find(branch => branch.name === current)?.name ??
        (matches.length === 1 ? matches[0].name : undefined);
}
