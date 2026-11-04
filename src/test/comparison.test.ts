import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runGit } from '../services/gitRunner';
import { loadComparison, loadComparisonFile, splitComparisonLines } from '../services/comparison';
import { parseDiffPreview } from '../services/gitUtils';

/** Two real diverged branches, with a rename and dirty working copy: PR scope is directional. */
it('compares merge-base or exact tips without including target-only or uncommitted work', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-compare-'));
    const git = (...args: string[]) => runGit(args, { cwd: root });
    const run = (args: string[]) => git(...args);
    try {
        await git('init', '-b', 'target');
        await git('config', 'user.name', 'Fixture');
        await git('config', 'user.email', 'fixture@example.invalid');
        fs.writeFileSync(path.join(root, 'original.txt'), 'one\ntwo\nthree\n');
        await git('add', '--', 'original.txt');
        await git('-c', 'commit.gpgsign=false', 'commit', '-m', 'base');
        const base = (await git('rev-parse', 'HEAD')).trim();
        await git('branch', 'source');
        fs.writeFileSync(path.join(root, 'target-only.txt'), 'target change\n');
        await git('add', '--', 'target-only.txt');
        await git('-c', 'commit.gpgsign=false', 'commit', '-m', 'target only');
        await git('checkout', 'source');
        await git('mv', 'original.txt', 'renamed file.txt');
        fs.writeFileSync(path.join(root, 'source.txt'), 'source change\n');
        fs.writeFileSync(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
        await git('add', '--', 'source.txt', 'binary.dat');
        await git('-c', 'commit.gpgsign=false', 'commit', '-m', 'source only');
        const source = (await git('rev-parse', 'HEAD')).trim();
        fs.appendFileSync(path.join(root, 'source.txt'), 'uncommitted\n');
        const before = await git('status', '--porcelain');
        const pr = await loadComparison(run, 'source', 'target', 'pr');
        assert.equal(pr.baseHash, base);
        assert.equal(pr.sourceHash, source);
        assert.equal(pr.ahead, 1); assert.equal(pr.behind, 1);
        assert.equal(pr.files.length, 3);
        assert.equal(pr.added, 1); assert.equal(pr.deleted, 0);
        const renamed = pr.files.find(file => file.path === 'renamed file.txt');
        assert.equal(renamed?.status, 'R'); assert.equal(renamed?.fromPath, 'original.txt');
        assert.ok(!pr.files.some(file => file.path === 'target-only.txt'));
        const renamePreview = await loadComparisonFile(run, pr, 'renamed file.txt');
        assert.ok(renamePreview.lines.some(line => line.text.includes('rename from original.txt')));
        assert.equal((await loadComparisonFile(run, pr, 'binary.dat')).binary, true);
        await assert.rejects(loadComparisonFile(run, pr, '../outside.txt'));
        const direct = await loadComparison(run, 'source', 'target', 'direct');
        assert.equal(direct.baseHash, direct.targetHash);
        assert.equal(direct.files.length, 4);
        assert.equal(direct.files.find(file => file.path === 'target-only.txt')?.status, 'D');
        const reverse = await loadComparison(run, 'target', 'source', 'pr');
        assert.deepEqual(reverse.files.map(file => file.path), ['target-only.txt']);
        assert.equal(await git('status', '--porcelain'), before);
        assert.equal((await git('rev-parse', 'HEAD')).trim(), source);

        // A ref moving while Git reads the diff must not change already-frozen endpoints.
        const frozen = await loadComparison(async args => {
            if (args[0] === 'diff') {await git('update-ref', 'refs/heads/source', base);}
            return run(args);
        }, 'source', 'target', 'pr');
        assert.equal(frozen.sourceHash, source);
        assert.deepEqual(frozen.files, pr.files);
        await git('update-ref', 'refs/heads/source', source);
        await assert.rejects(loadComparison(run, 'missing-ref', 'target', 'pr'));
        await assert.rejects(loadComparison(async args => {
            if (args[0] === 'diff') {throw new Error('read failed');}
            return run(args);
        }, 'source', 'target', 'pr'), /read failed/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

it('aligns replacement blocks while preserving each side and padding additions/deletions', () => {
    const preview = parseDiffPreview('@@ -1,4 +1,5 @@\n same\n-old one\n-old two\n+new one\n+new two\n+new three\n tail\n', 100);
    const rows = splitComparisonLines(preview.lines);
    assert.equal(rows[0].note, '@@ -1,4 +1,5 @@');
    assert.deepEqual(rows[2], { left: { line: 2, text: 'old one', changed: true }, right: { line: 2, text: 'new one', changed: true } });
    assert.equal(rows[4].left, undefined);
    assert.equal(rows[4].right?.text, 'new three');
    assert.equal(rows[5].left?.line, 4);
    assert.equal(rows[5].right?.line, 5);
    const removed = splitComparisonLines(parseDiffPreview('@@ -1 +0,0 @@\n-gone\n', 100).lines);
    assert.equal(removed[1].right, undefined);
    assert.equal(removed[1].left?.text, 'gone');
});
