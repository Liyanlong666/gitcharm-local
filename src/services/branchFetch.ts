import { t } from '../i18n';
import { assertRef } from './gitUtils';

/** Remote source and local remote-tracking destination; never a local branch destination. */
export interface BranchFetchTarget {
    remote: string;
    sourceRef: string;
    trackingRef: string;
}

/** Read configured upstream/refspecs rather than guessing origin or equal branch names. */
export async function resolveBranchFetchTarget(
    run: (args: string[]) => Promise<string>, selected?: string
): Promise<BranchFetchTarget | undefined> {
    const branch = selected ?? await run(['symbolic-ref', '--quiet', '--short', 'HEAD']).then(s => s.trim()).catch(() => '');
    if (!branch) {return undefined;}
    assertRef(branch);
    const localRef = `refs/heads/${branch}`;
    const records = (await run(['for-each-ref', localRef,
        '--format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)'])).trim().split('\n');
    const local = records.map(row => row.split('\0')).find(row => row[0] === localRef);
    if (local) {
        if (!local[2] || local[2] === '.' || !local[1]?.startsWith('refs/remotes/') || !local[3]) {return undefined;}
        return { remote: local[2], sourceRef: local[3], trackingRef: local[1] };
    }

    // A selected remote branch may have no local tracker. Reverse its configured
    // fetch refspec, including nonstandard destinations and remote names with '/'.
    const destination = `refs/remotes/${branch}`;
    const remotes = (await run(['remote'])).trim().split('\n').filter(Boolean);
    const matches: BranchFetchTarget[] = [];
    for (const remote of remotes) {
        const specs = await run(['config', '--get-all', `remote.${remote}.fetch`]).catch(() => '');
        for (const raw of specs.trim().split('\n')) {
            if (!raw || raw.startsWith('^')) {continue;}
            const [source, dest] = raw.replace(/^\+/, '').split(':');
            if (!source || !dest) {continue;}
            if (dest === destination && !source.includes('*')) {
                matches.push({ remote, sourceRef: source, trackingRef: destination });
            } else if (dest.includes('*') && source.includes('*')) {
                const [prefix, suffix] = dest.split('*');
                if (destination.startsWith(prefix) && destination.endsWith(suffix)) {
                    const middle = destination.slice(prefix.length, suffix ? -suffix.length : undefined);
                    matches.push({ remote, sourceRef: source.replace('*', middle), trackingRef: destination });
                }
            }
        }
    }
    const unique = [...new Map(matches.map(target => [JSON.stringify(target), target])).values()];
    return unique.length === 1 ? unique[0] : undefined;
}

/** Fetch only into remote-tracking refs; the leading + supports ordinary remote history rewrites. */
export function branchFetchArgs(target: BranchFetchTarget): string[] {
    for (const ref of [target.remote, target.sourceRef, target.trackingRef]) {assertRef(ref);}
    if (target.remote === '.' || !target.sourceRef.startsWith('refs/heads/') || !target.trackingRef.startsWith('refs/remotes/')) {
        throw new Error(t('history.invalidFetchTarget'));
    }
    return ['fetch', '--no-recurse-submodules', target.remote, `+${target.sourceRef}:${target.trackingRef}`];
}
