import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runGit } from '../services/gitRunner';
import { loadTrackingHistory, trackingLocalForSelection } from '../services/trackingHistory';
import { RefsReader } from '../services/refsReader';

/** Exercise real Git topology on disposable local remotes, including differently named tracking branches. */
it('pairs the configured upstream and counts synced/behind/diverged/ahead without modifying user work', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-tracking-'));
    const remote = path.join(root, 'remote.git');
    const producer = path.join(root, 'producer');
    const local = path.join(root, 'local');
    const linked = path.join(root, 'linked');
    const git = (cwd: string, ...args: string[]) => runGit(args, { cwd }).then(s => s.trim());
    const read = () => loadTrackingHistory(args => git(local, ...args));
    try {
        await git(root, 'init', '--bare', remote);
        await git(root, 'init', '-b', 'main', producer);
        await git(producer, 'config', 'user.name', 'Fixture');
        await git(producer, 'config', 'user.email', 'fixture@example.invalid');
        fs.writeFileSync(path.join(producer, 'keep.txt'), 'base\n');
        await git(producer, 'add', '--', 'keep.txt');
        await git(producer, '-c', 'commit.gpgsign=false', 'commit', '-m', 'base');
        await git(producer, 'remote', 'add', 'origin', remote);
        await git(producer, 'push', 'origin', 'main');
        await git(root, 'clone', '-b', 'main', remote, local);
        await git(local, 'remote', 'rename', 'origin', 'company');
        await git(local, 'branch', '-m', 'work');
        await git(local, 'config', 'user.name', 'Fixture');
        await git(local, 'config', 'user.email', 'fixture@example.invalid');
        const synced = await read();
        assert.equal(synced.branch, 'work');
        assert.equal(synced.upstream, 'company/main');
        assert.equal(synced.status, 'synced');
        const base = synced.revisions[0];
        await git(local, 'pack-refs', '--all', '--prune');
        fs.appendFileSync(path.join(local, 'keep.txt'), 'unstaged user work\n');
        const beforeDiff = await git(local, 'diff');
        const beforeIndex = await git(local, 'ls-files', '--stage');
        await git(producer, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'remote first');
        await git(producer, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'remote second');
        const remoteTip = await git(producer, 'rev-parse', 'HEAD');
        await git(producer, 'push', 'origin', 'main');
        await git(local, 'fetch', 'company');
        const behind = await read();
        assert.deepEqual([behind.status, behind.ahead, behind.behind], ['behind', 0, 2]);
        assert.ok(behind.revisions.includes(base) && behind.revisions.includes(remoteTip));
        assert.equal((await git(local, 'log', ...behind.revisions, '--format=%H')).split('\n').length, 3);
        assert.equal(await git(local, 'rev-parse', 'HEAD'), base, 'fetch must not pull');
        assert.equal(await git(local, 'diff'), beforeDiff);
        assert.equal(await git(local, 'ls-files', '--stage'), beforeIndex);

        await git(local, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'local only');
        const diverged = await read();
        assert.deepEqual([diverged.status, diverged.ahead, diverged.behind], ['diverged', 1, 2]);
        const combined = (await git(local, 'log', ...diverged.revisions, '--format=%H')).split('\n');
        assert.equal(combined.length, 4, 'both sides remain visible when their tips diverge');
        assert.ok(combined.includes(remoteTip));
        const immutableRoots = [...diverged.revisions];
        await git(producer, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'during display');
        await git(producer, 'push', 'origin', 'main');
        await git(local, 'fetch', 'company');
        assert.equal((await read()).behind, 3);
        assert.equal((await git(local, 'log', ...immutableRoots, '--format=%H')).split('\n').length, 4,
            'an in-flight fetch cannot change the roots of an already counted snapshot');

        // Use a second valid tracking ref to prove that config-only changes matter.
        await git(local, 'update-ref', 'refs/remotes/company/baseline', base);
        const reader = new RefsReader(() => local);
        const signature = reader.readHistorySignature();
        await git(local, 'branch', '--set-upstream-to=company/baseline', 'work');
        assert.notEqual(reader.readHistorySignature(), signature);
        const ahead = await read();
        assert.deepEqual([ahead.status, ahead.ahead, ahead.behind], ['ahead', 1, 0]);
        await git(local, 'worktree', 'add', '-b', 'linked-work', linked, 'work');
        await git(linked, 'branch', '--set-upstream-to=company/main', 'linked-work');
        const linkedState = await loadTrackingHistory(args => git(linked, ...args));
        assert.deepEqual([linkedState.upstream, linkedState.ahead, linkedState.behind], ['company/main', 1, 3]);

        await git(local, 'update-ref', '-d', 'refs/remotes/company/baseline');
        assert.equal((await read()).status, 'missingUpstream', 'missing upstream is not reported as synced');
        await git(local, 'branch', '--unset-upstream', 'work');
        assert.equal((await read()).status, 'noUpstream', 'do not silently substitute a same-named remote');
        await git(linked, 'checkout', '--detach');
        assert.equal((await loadTrackingHistory(args => git(linked, ...args))).status, 'detached');
        assert.equal(await git(local, 'diff'), beforeDiff, 'all inspection preserves working files');
        assert.equal(await git(local, 'ls-files', '--stage'), beforeIndex);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});


it('pairs a selected remote only with an actual, unambiguous local tracker', () => {
    const locals = [
        { name: 'work', upstream: 'company/main' },
        { name: 'review', upstream: 'company/main' },
        { name: 'release', upstream: 'company/stable' },
        { name: 'untracked' }
    ];
    assert.equal(trackingLocalForSelection('work', locals), 'work');
    assert.equal(trackingLocalForSelection('work', locals, 'release'), 'release');
    assert.equal(trackingLocalForSelection('work', locals, 'company/main'), 'work');
    assert.equal(trackingLocalForSelection('untracked', locals, 'company/main'), undefined);
    assert.equal(trackingLocalForSelection('work', locals, 'company/stable'), 'release');
    assert.equal(trackingLocalForSelection('work', locals, 'company/untracked'), undefined);
});
