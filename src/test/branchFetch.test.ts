import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runGit } from '../services/gitRunner';
import { resolveBranchFetchTarget, branchFetchArgs } from '../services/branchFetch';

it('fetches only the actual tracked branch into its remote ref and preserves local work', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-button-fetch-'));
    const remote = path.join(root, 'remote.git');
    const seed = path.join(root, 'seed');
    const local = path.join(root, 'local');
    const git = (cwd: string, ...args: string[]) => runGit(args, { cwd }).then(s => s.trim());
    try {
        await git(root, 'init', '--bare', remote);
        await git(root, 'init', '-b', 'main', seed);
        await git(seed, 'config', 'user.name', 'Fixture');
        await git(seed, 'config', 'user.email', 'fixture@example.invalid');
        fs.writeFileSync(path.join(seed, 'file.txt'), 'base\n');
        await git(seed, 'add', 'file.txt');
        await git(seed, '-c', 'commit.gpgsign=false', 'commit', '-m', 'base');
        await git(seed, 'branch', 'other');
        await git(seed, 'remote', 'add', 'origin', remote);
        await git(seed, 'push', 'origin', 'main', 'other');
        await git(root, 'clone', '-b', 'main', remote, local);
        await git(local, 'remote', 'rename', 'origin', 'company');
        await git(local, 'branch', '-m', 'work');
        const head = await git(local, 'rev-parse', 'HEAD');
        const index = await git(local, 'ls-files', '--stage');
        fs.appendFileSync(path.join(local, 'file.txt'), 'keep work\n');
        const dirty = await git(local, 'diff');
        const target = await resolveBranchFetchTarget(args => git(local, ...args));
        assert.deepEqual(target, { remote: 'company', sourceRef: 'refs/heads/main', trackingRef: 'refs/remotes/company/main' });
        await git(seed, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'new remote commit');
        await git(seed, 'branch', '-f', 'other', 'HEAD');
        const next = await git(seed, 'rev-parse', 'HEAD');
        await git(seed, 'push', 'origin', 'main', 'other');
        await git(local, ...branchFetchArgs(target!));
        assert.equal(await git(local, 'rev-parse', 'company/main'), next);
        assert.equal(await git(local, 'rev-parse', 'company/other'), head, 'unselected remote branch is not fetched');
        assert.equal(await git(local, 'rev-parse', 'HEAD'), head, 'no pull or merge');
        assert.equal(await git(local, 'ls-files', '--stage'), index);
        assert.equal(await git(local, 'diff'), dirty);
        const remoteOnly = await resolveBranchFetchTarget(args => git(local, ...args), 'company/other');
        assert.equal(remoteOnly?.sourceRef, 'refs/heads/other');
        await git(local, 'config', 'remote.company.fetch', '+refs/heads/*:refs/remotes/mirror/*');
        const remapped = await resolveBranchFetchTarget(args => git(local, ...args), 'mirror/other');
        assert.deepEqual(remapped, { remote: 'company', sourceRef: 'refs/heads/other', trackingRef: 'refs/remotes/mirror/other' });
        await git(local, 'branch', '--unset-upstream', 'work');
        assert.equal(await resolveBranchFetchTarget(args => git(local, ...args)), undefined);
        assert.throws(() => branchFetchArgs({ remote: 'company', sourceRef: 'refs/heads/main', trackingRef: 'refs/heads/work' }));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
