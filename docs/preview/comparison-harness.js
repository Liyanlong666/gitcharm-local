/** Deterministic UI fixture. Git semantics are exercised separately in comparison.test.ts. */
(function () {
    var generation = 0, mode = 'pr', swapped = false;
    var files = [
        { status: 'M', path: 'src/views/graphView.ts', added: 8, deleted: 5 },
        { status: 'A', path: 'src/views/comparisonEditor.ts', added: 140, deleted: 0 },
        { status: 'R', path: 'media/renamed style.css', fromPath: 'media/style.css', added: 0, deleted: 0 }
    ];
    function send(message) {window.dispatchEvent(new MessageEvent('message', { data: message }));}
    function load() {
        generation++;
        var source = swapped ? 'origin/main' : 'feat/comparison-tab', target = swapped ? 'feat/comparison-tab' : 'origin/main';
        send({ command: 'comparison', generation: generation, source: source, target: target, mode: mode,
            snapshot: { source: source, target: target, sourceHash: 'a'.repeat(40), targetHash: 'b'.repeat(40), baseHash: (mode === 'pr' ? 'c' : 'b').repeat(40),
                mode: mode, files: files, added: 148, deleted: 5, ahead: 3, behind: 2 } });
    }
    window.acquireVsCodeApi = function () {return {
        getState: function () {return {};}, setState: function () {},
        postMessage: function (message) {
            if (message.command === 'ready' || message.command === 'refresh') {load();}
            if (message.command === 'changeMode') {mode = message.mode; load();}
            if (message.command === 'swap') {swapped = !swapped; load();}
            if (message.command === 'selectFile') {
                send({ command: 'file', generation: generation, requestId: message.requestId, path: message.path, rows: [
                    { note: '@@ -10,4 +10,5 @@' },
                    { left: { line: 10, text: 'async function compare(source, target) {', changed: false }, right: { line: 10, text: 'async function compare(source, target) {', changed: false } },
                    { left: { line: 11, text: '    return showDialog(source, target);', changed: true }, right: { line: 11, text: '    const snapshot = await readComparison(source, target);', changed: true } },
                    { right: { line: 12, text: '    return ComparisonEditor.show(snapshot);', changed: true } },
                    { left: { line: 12, text: '}', changed: false }, right: { line: 13, text: '}', changed: false } }
                ] });
            }
        }
    };};
})();
