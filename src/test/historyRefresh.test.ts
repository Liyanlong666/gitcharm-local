import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runGit } from '../services/gitRunner';
import { RefsReader } from '../services/refsReader';

/** Real, disposable local repositories: no company repository or network remote. */
it('detects fetched remote history without moving HEAD or touching working files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-fetch-'));
    const git = async (cwd: string, ...args: string[]) =>
        (await runGit(args, { cwd })).trim();
    const remote = path.join(root, 'remote.git');
    const producer = path.join(root, 'producer');
    const consumer = path.join(root, 'consumer');
    const linked = path.join(root, 'linked');
    try {
        await git(root, 'init', '--bare', remote);
        await git(root, 'init', '-b', 'main', producer);
        await git(producer, 'config', 'user.name', 'Fixture Author');
        await git(producer, 'config', 'user.email', 'fixture@example.invalid');
        fs.writeFileSync(path.join(producer, 'file.txt'), 'base\n');
        await git(producer, 'add', '--', 'file.txt');
        await git(producer, '-c', 'commit.gpgsign=false', 'commit', '-m', 'base');
        await git(producer, 'remote', 'add', 'origin', remote);
        await git(producer, 'push', 'origin', 'main');
        await git(root, 'clone', '-b', 'main', remote, consumer);
        await git(consumer, 'pack-refs', '--all', '--prune');
        await git(consumer, 'worktree', 'add', '--detach', linked, 'HEAD');
        const reader = new RefsReader(() => consumer);
        const worktreeReader = new RefsReader(() => linked);
        const head = await git(consumer, 'rev-parse', 'HEAD');
        const indexBefore = await git(consumer, 'ls-files', '--stage');
        fs.appendFileSync(path.join(consumer, 'file.txt'), 'keep local edit\n');
        const workingBefore = await git(consumer, 'diff');
        const before = reader.readHistorySignature();
        const linkedBefore = worktreeReader.readHistorySignature();
        assert.ok(before);
        assert.equal(reader.readHistorySignature(), before, 'unchanged refs must not force refresh');

        await git(producer, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'remote-only');
        const fetched = await git(producer, 'rev-parse', 'HEAD');
        await git(producer, 'push', 'origin', 'main');
        await git(consumer, 'fetch', 'origin');
        const after = reader.readHistorySignature();
        assert.notEqual(after, before, 'fetch must invalidate all-refs history although local HEAD is unchanged');
        assert.notEqual(worktreeReader.readHistorySignature(), linkedBefore, 'linked worktrees see shared remote refs');
        assert.equal(reader.readBranchRefs().get('origin/main'), fetched, 'new loose ref wins over packed old ref');
        const all = (await git(consumer, 'log', '--all', '--format=%H')).split('\n');
        assert.ok(all.includes(head) && all.includes(fetched));
        assert.equal(await git(consumer, 'rev-parse', 'HEAD'), head);
        assert.equal(await git(consumer, 'ls-files', '--stage'), indexBefore);
        assert.equal(await git(consumer, 'diff'), workingBefore);

        await git(consumer, 'fetch', 'origin');
        assert.equal(reader.readHistorySignature(), after, 'a no-op fetch must not cause another log reload');
        await git(consumer, 'pack-refs', '--all', '--prune');
        assert.equal(reader.readHistorySignature(), after, 'packing unchanged refs must not cause refresh');
        await git(consumer, 'branch', 'local-extra', 'HEAD');
        const branchAdded = reader.readHistorySignature();
        assert.notEqual(branchAdded, after, 'new labels matter even at an existing commit');
        await git(consumer, 'update-ref', '-d', 'refs/heads/local-extra');
        assert.equal(reader.readHistorySignature(), after);
        await git(consumer, 'tag', 'local-tag', 'HEAD');
        assert.notEqual(reader.readHistorySignature(), after);
        await git(consumer, 'update-ref', '-d', 'refs/tags/local-tag');
        assert.equal(reader.readHistorySignature(), after);
        await git(consumer, 'update-ref', '-d', 'refs/remotes/origin/main');
        assert.notEqual(reader.readHistorySignature(), after, 'remote deletion must refresh history and labels');
        await git(linked, 'update-ref', 'HEAD', fetched);
        assert.notEqual(worktreeReader.readHistorySignature(), linkedBefore, 'detached HEAD participates in the signature');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
