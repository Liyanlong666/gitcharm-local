/* Read-only comparison tab. Git inputs and immutable snapshots belong to the host. */
(function () {
    'use strict';
    var vscode = acquireVsCodeApi();
    var state = null, selected = '', requestId = 0, collapsed = new Set();
    var saved = vscode.getState() || {};
    var $ = function (id) {return document.getElementById(id);};
    var T = function (key, values) {
        var text = window.I18N_STRINGS[key] || key;
        Object.keys(values || {}).forEach(function (name) {text = text.split('{' + name + '}').join(String(values[name]));});
        return text;
    };
    var entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    var esc = function (value) {return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {return entities[c];});};
    var short = function (ref) {return String(ref).replace(/^refs\/(heads|remotes)\//, '');};
    var files = function () {return state && state.snapshot ? state.snapshot.files : [];};
    // File navigation follows the rendered tree: folders first at each level.
    function comparePaths(a, b) {
        var left = a.path.split('/'), right = b.path.split('/');
        for (var i = 0; i < Math.min(left.length, right.length); i++) {
            if (left[i] === right[i]) {continue;}
            var leftDir = i < left.length - 1, rightDir = i < right.length - 1;
            if (leftDir !== rightDir) {return leftDir ? -1 : 1;}
            return left[i].localeCompare(right[i]);
        }
        return left.length - right.length;
    }
    var visibleFiles = function () {
        var filter = $('filter').value.trim().toLowerCase();
        return files().filter(function (file) {return file.path.toLowerCase().includes(filter) || (file.fromPath || '').toLowerCase().includes(filter);}).sort(comparePaths);
    };

    function fileTree() {
        var root = { dirs: new Map(), files: [] };
        visibleFiles().forEach(function (file) {
            var parts = file.path.split('/'), node = root;
            parts.slice(0, -1).forEach(function (name) {
                if (!node.dirs.has(name)) {node.dirs.set(name, { dirs: new Map(), files: [] });}
                node = node.dirs.get(name);
            });
            node.files.push(file);
        });
        function render(node, prefix, depth) {
            var html = '';
            Array.from(node.dirs.keys()).sort(function (a, b) {return a.localeCompare(b);}).forEach(function (name) {
                var path = prefix + name, closed = collapsed.has(path);
                html += '<button class="folder" role="treeitem" aria-expanded="' + !closed + '" data-dir="' + esc(path) + '" style="--depth:' + depth + '"><span>' + (closed ? '›' : '⌄') + '</span><span>' + esc(name) + '</span></button>';
                if (!closed) {html += '<div role="group">' + render(node.dirs.get(name), path + '/', depth + 1) + '</div>';}
            });
            node.files.sort(function (a, b) {return a.path.localeCompare(b.path);}).forEach(function (file) {
                var label = file.path.split('/').pop();
                html += '<button class="file' + (file.path === selected ? ' selected' : '') + '" role="treeitem" aria-selected="' + (file.path === selected) + '" data-path="' + esc(file.path) + '" data-title="' + esc(file.fromPath ? file.fromPath + ' → ' + file.path : file.path) + '" style="--depth:' + depth + '">' +
                    '<span class="status ' + esc(file.status) + '">' + esc(file.status) + '</span><span class="name">' + esc(label) + '</span><span class="counts">+' + file.added + ' −' + file.deleted + '</span></button>';
            });
            return html;
        }
        $('files').innerHTML = render(root, '', 0) || '<div class="note">' + esc(T('comparison.noMatchingFiles')) + '</div>';
        navigation();
    }

    function navigation() {
        var list = visibleFiles(), index = list.findIndex(function (file) {return file.path === selected;});
        $('previous').disabled = !list.length || index <= 0;
        $('next').disabled = !list.length || index >= list.length - 1;
        $('native').disabled = !files().some(function (file) {return file.path === selected;});
    }

    function choose(path) {
        var file = files().find(function (item) {return item.path === path;});
        if (!file) {return;}
        selected = path;
        // Keep the existing row nodes: recreating them here would swallow double-clicks.
        document.querySelectorAll('.file').forEach(function (row) {
            var active = row.dataset.path === path;
            row.classList.toggle('selected', active); row.setAttribute('aria-selected', String(active));
        });
        $('filename').textContent = file.fromPath ? file.fromPath + ' → ' + file.path : file.path;
        $('left-title').textContent = (file.fromPath || file.path) + ' · ' + state.snapshot.baseHash.slice(0, 8);
        $('right-title').textContent = file.path + ' · ' + state.snapshot.sourceHash.slice(0, 8);
        $('patch').innerHTML = '<div class="note">' + esc(T('preview.loading')) + '</div>';
        navigation();
        vscode.postMessage({ command: 'selectFile', generation: state.generation, requestId: ++requestId, path: path });
    }

    function update(message) {
        if (state && message.generation < state.generation) {return;}
        state = message;
        requestId++;
        var busy = !message.snapshot && !message.error;
        ['pr', 'direct', 'swap', 'refresh'].forEach(function (id) {$(id).disabled = busy;});
        $('pr').classList.toggle('active', message.mode === 'pr');
        $('direct').classList.toggle('active', message.mode === 'direct');
        $('refs').textContent = short(message.source) + ' → ' + short(message.target);
        $('refs').setAttribute('data-title', message.source + ' → ' + message.target);
        $('summary').classList.toggle('error', !!message.error);
        $('summary').textContent = message.error ? T('comparison.failed', { error: message.error }) : busy ? T('comparison.loading') :
            T('w.filesCount', { n: message.snapshot.files.length }) + '   +' + message.snapshot.added + ' −' + message.snapshot.deleted + '   ·   ' +
            T('comparison.commits', { ahead: message.snapshot.ahead, behind: message.snapshot.behind }) + '   ·   ' +
            T('comparison.base') + ' ' + message.snapshot.baseHash.slice(0, 8) + '   ·   ' + T(message.mode === 'pr' ? 'comparison.prHint' : 'comparison.directHint');
        fileTree();
        if (!message.snapshot) {
            $('filename').textContent = ''; $('left-title').textContent = ''; $('right-title').textContent = '';
            $('patch').innerHTML = '<div class="note' + (message.error ? ' error' : '') + '">' + esc(message.error ? T('comparison.failed', { error: message.error }) : T('comparison.loading')) + '</div>';
            return;
        }
        var file = files().find(function (item) {return item.path === selected;}) || visibleFiles()[0];
        if (file) {choose(file.path);}
        else {
            selected = ''; $('filename').textContent = ''; $('left-title').textContent = ''; $('right-title').textContent = '';
            $('patch').innerHTML = '<div class="note">' + esc(T('common.noFileChanges')) + '</div>';
        }
    }

    function renderDiff(message) {
        if (!state || message.generation !== state.generation || message.path !== selected || message.requestId !== requestId) {return;}
        if (message.error || message.binary) {
            $('patch').innerHTML = '<div class="note' + (message.error ? ' error' : '') + '">' + esc(message.error ? T('preview.failed', { error: message.error }) : T('preview.binary')) + '</div>';
            return;
        }
        function cell(value, side) {
            if (!value) {return '<div class="cell absent"></div>';}
            return '<div class="cell ' + (value.changed ? side : '') + '"><span class="line">' + esc(value.line) + '</span><code>' + esc(value.text) + '</code></div>';
        }
        var rows = message.rows || [];
        $('patch').innerHTML = rows.map(function (row) {
            return row.note !== undefined ? '<div class="hunk">' + esc(row.note) + '</div>' :
                '<div class="diff-row">' + cell(row.left, 'removed') + cell(row.right, 'added') + '</div>';
        }).join('') + (message.truncated ? '<div class="note">' + esc(T('comparison.truncated')) + '</div>' : '') || '<div class="note">' + esc(T('preview.empty')) + '</div>';
        $('patch').scrollTop = 0;
    }

    window.addEventListener('message', function (event) {
        var message = event.data;
        if (message.command === 'comparison') {update(message);}
        else if (message.command === 'file') {renderDiff(message);}
    });
    $('files').addEventListener('click', function (event) {
        var folder = event.target.closest('[data-dir]');
        if (folder) {
            var key = folder.dataset.dir;
            if (collapsed.has(key)) {collapsed.delete(key);} else {collapsed.add(key);}
            fileTree(); return;
        }
        var row = event.target.closest('[data-path]');
        if (row) {choose(row.dataset.path);}
    });
    function nativeDiff() {
        if (state && files().some(function (file) {return file.path === selected;})) {
            vscode.postMessage({ command: 'openNativeDiff', generation: state.generation, path: selected });
        }
    }
    $('files').addEventListener('dblclick', function (event) {if (event.target.closest('[data-path]')) {nativeDiff();}});
    $('native').addEventListener('click', nativeDiff);
    $('filter').addEventListener('input', fileTree);
    ['pr', 'direct'].forEach(function (id) {$(id).addEventListener('click', function () {vscode.postMessage({ command: 'changeMode', mode: id });});});
    ['refresh', 'swap'].forEach(function (id) {$(id).addEventListener('click', function () {vscode.postMessage({ command: id });});});
    ['previous', 'next'].forEach(function (id) {
        $(id).addEventListener('click', function () {
            var list = visibleFiles(), index = list.findIndex(function (file) {return file.path === selected;});
            var file = list[index + (id === 'next' ? 1 : -1)]; if (file) {choose(file.path);}
        });
    });
    // Persist presentation only; Git inputs are always reconstructed by the host.
    function width(value) {
        var size = Math.max(170, Math.min(value, window.innerWidth * .55));
        document.documentElement.style.setProperty('--tree-width', size + 'px');
        saved.treeWidth = size; vscode.setState(saved);
    }
    if (typeof saved.treeWidth === 'number') {width(saved.treeWidth);}
    $('divider').addEventListener('pointerdown', function (event) {
        if (event.button !== 0) {return;}
        event.preventDefault(); var grip = event.currentTarget; grip.setPointerCapture(event.pointerId);
        document.body.classList.add('resizing');
        function move(e) {width(e.clientX);}
        function stop() {grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', stop); grip.removeEventListener('pointercancel', stop); document.body.classList.remove('resizing');}
        grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', stop); grip.addEventListener('pointercancel', stop);
    });
    $('divider').addEventListener('keydown', function (event) {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {event.preventDefault(); width(document.querySelector('aside').offsetWidth + (event.key === 'ArrowRight' ? 20 : -20));}
    });
    var hint = $('tooltip');
    function hideHint() {hint.style.display = 'none';}
    document.addEventListener('mouseover', function (event) {
        var target = event.target.closest('[data-title]');
        if (!target) {hideHint(); return;}
        hint.textContent = target.getAttribute('data-title'); hint.style.display = 'block';
        hint.style.left = Math.min(event.clientX + 8, window.innerWidth - hint.offsetWidth - 8) + 'px';
        hint.style.top = Math.min(event.clientY + 20, window.innerHeight - hint.offsetHeight - 8) + 'px';
    });
    document.addEventListener('mouseout', hideHint);
    document.addEventListener('pointerdown', hideHint);
    document.addEventListener('scroll', hideHint, true);
    vscode.postMessage({ command: 'ready' });
})();
