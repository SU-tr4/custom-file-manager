document.addEventListener('DOMContentLoaded', () => {
    'use strict';

    const cfg = window.cfmConfig || {};
    const ajaxUrl = cfg.ajaxUrl || window.ajaxurl;

    const fileListEl = document.getElementById('cfm-file-list');
    const treeEl = document.getElementById('cfm-tree-container');
    const breadcrumbEl = document.getElementById('cfm-breadcrumb');
    const currentFileEl = document.getElementById('cfm-current-file');
    const contentEl = document.getElementById('cfm-file-content');
    const saveBtn = document.getElementById('cfm-save-btn');
    const statusEl = document.getElementById('cfm-status');
    const newNameInput = document.getElementById('cfm-new-name');
    const createFileBtn = document.getElementById('cfm-create-file-btn');
    const createDirBtn = document.getElementById('cfm-create-dir-btn');
    const uploadFilesInput = document.getElementById('cfm-upload-files');
    const uploadFolderInput = document.getElementById('cfm-upload-folder');
    const uploadFilesBtn = document.getElementById('cfm-upload-files-btn');
    const uploadFolderBtn = document.getElementById('cfm-upload-folder-btn');
    const uploadStatusEl = document.getElementById('cfm-upload-status');
    const uploadHint = uploadStatusEl.textContent;

    let currentDir = '';
    let currentFile = '';
    let currentEol = '\n';
    let dirty = false;
    let loadSeq = 0;
    let uploading = false;

    /* ------------------------------------------------------------
     * API
     * ---------------------------------------------------------- */
    async function api(action, fields = {}, uploadFile = null) {
        const fd = new FormData();
        fd.append('action', action);
        fd.append('nonce', cfg.nonce || '');
        Object.keys(fields).forEach(k => fd.append(k, fields[k]));
        if (uploadFile) fd.append('upload', uploadFile, uploadFile.name);

        const res = await fetch(ajaxUrl, { method: 'POST', body: fd, credentials: 'same-origin' });
        const text = await res.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch (e) {
            throw new Error('サーバーから不正な応答が返りました（HTTP ' + res.status + '）。');
        }
        if (!json || !json.success) {
            throw new Error(json && typeof json.data === 'string' ? json.data : '処理に失敗しました（HTTP ' + res.status + '）。');
        }
        return json.data;
    }

    function setStatus(text, type) {
        statusEl.textContent = text;
        statusEl.className = 'cfm-status' + (type ? ' is-' + type : '');
    }

    /* ------------------------------------------------------------
     * 確認モーダル（ブラウザのダイアログ抑止の影響を受けない）
     * ---------------------------------------------------------- */
    function showConfirm({ title, lines, okLabel, danger }) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'cfm-modal-overlay';

            const box = document.createElement('div');
            box.className = 'cfm-modal' + (danger ? ' is-danger' : '');
            box.setAttribute('role', 'alertdialog');
            box.setAttribute('aria-modal', 'true');

            const h = document.createElement('h3');
            h.textContent = title;
            box.appendChild(h);

            lines.forEach((t) => {
                const p = document.createElement('p');
                p.textContent = t;
                box.appendChild(p);
            });

            const btns = document.createElement('div');
            btns.className = 'cfm-modal-buttons';

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'button';
            cancelBtn.textContent = 'キャンセル';

            const okBtn = document.createElement('button');
            okBtn.type = 'button';
            okBtn.className = 'button cfm-modal-ok' + (danger ? ' is-danger' : '');
            okBtn.textContent = okLabel || 'OK';

            btns.appendChild(cancelBtn);
            btns.appendChild(okBtn);
            box.appendChild(btns);
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            const close = (result) => {
                document.removeEventListener('keydown', onKey, true);
                overlay.remove();
                resolve(result);
            };
            const onKey = (e) => {
                if (e.key === 'Escape') { e.preventDefault(); close(false); }
            };
            document.addEventListener('keydown', onKey, true);

            cancelBtn.addEventListener('click', () => close(false));
            okBtn.addEventListener('click', () => close(true));
            overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });

            cancelBtn.focus(); // 誤操作防止のため初期フォーカスはキャンセル
        });
    }

    /* ------------------------------------------------------------
     * エディタ（WordPress 標準 CodeMirror。使えない場合は textarea）
     * ---------------------------------------------------------- */
    const editor = createEditor();

    function createEditor() {
        let cm = null;
        let saveCb = () => {};
        let changeCb = () => {};

        if (window.wp && wp.codeEditor && cfg.editorSettings) {
            try {
                const base = cfg.editorSettings;
                const baseCm = base.codemirror || {};
                const settings = Object.assign({}, base);
                settings.codemirror = Object.assign({}, baseCm, {
                    mode: 'text/plain',
                    theme: 'monokai',
                    lineNumbers: true,
                    lineWrapping: false,
                    lint: false,
                    gutters: ['CodeMirror-linenumbers'],
                    indentUnit: 4,
                    tabSize: 4,
                    indentWithTabs: true,
                    matchBrackets: true,
                    autoCloseBrackets: false,
                    autoCloseTags: false,
                    styleActiveLine: true,
                    readOnly: true,
                    extraKeys: Object.assign({}, baseCm.extraKeys || {}, {
                        'Ctrl-S': () => saveCb(),
                        'Cmd-S': () => saveCb()
                    })
                });
                const instance = wp.codeEditor.initialize(contentEl, settings);
                cm = instance.codemirror;
                cm.on('change', () => changeCb());
            } catch (e) {
                console.error('CodeMirror の初期化に失敗したため textarea を使用します', e);
                cm = null;
            }
        }

        if (!cm) {
            contentEl.addEventListener('keydown', (e) => {
                if (e.key === 'Tab') {
                    e.preventDefault();
                    const s = contentEl.selectionStart;
                    const en = contentEl.selectionEnd;
                    contentEl.value = contentEl.value.substring(0, s) + '\t' + contentEl.value.substring(en);
                    contentEl.selectionStart = contentEl.selectionEnd = s + 1;
                    changeCb();
                } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault();
                    saveCb();
                }
            });
            contentEl.addEventListener('input', () => changeCb());
        }

        return {
            getValue: () => (cm ? cm.getValue() : contentEl.value),
            setValue: (v) => {
                if (cm) {
                    cm.setValue(v);
                    cm.clearHistory();
                    cm.setCursor(0, 0);
                    cm.scrollTo(0, 0);
                    cm.refresh();
                } else {
                    contentEl.value = v;
                    contentEl.scrollTop = 0;
                }
            },
            setReadOnly: (b) => {
                if (cm) cm.setOption('readOnly', b);
                else contentEl.disabled = b;
            },
            setMode: (m) => { if (cm) cm.setOption('mode', m); },
            onSave: (fn) => { saveCb = fn; },
            onChange: (fn) => { changeCb = fn; }
        };
    }

    function modeFor(path) {
        const name = path.split('/').pop().toLowerCase();
        const ext = name.indexOf('.') >= 0 ? name.split('.').pop() : '';
        const map = {
            php: 'application/x-httpd-php', phtml: 'application/x-httpd-php', inc: 'application/x-httpd-php',
            html: 'application/x-httpd-php', htm: 'application/x-httpd-php',
            js: 'text/javascript', mjs: 'text/javascript', jsx: 'text/jsx',
            ts: 'text/typescript',
            json: 'application/json',
            css: 'text/css', scss: 'text/x-scss', less: 'text/x-less',
            xml: 'application/xml', svg: 'application/xml',
            md: 'text/x-markdown', markdown: 'text/x-markdown',
            yml: 'text/x-yaml', yaml: 'text/x-yaml',
            sql: 'text/x-sql',
            sh: 'text/x-sh'
        };
        return map[ext] || 'text/plain';
    }

    let loadingContent = false;
    editor.onChange(() => {
        if (loadingContent || !currentFile) return;
        if (!dirty) {
            dirty = true;
            setStatus('● 未保存の変更があります', 'warn');
        }
    });
    editor.onSave(() => saveFile());

    /* ------------------------------------------------------------
     * ファイル一覧
     * ---------------------------------------------------------- */
    function renderBreadcrumb(dir) {
        breadcrumbEl.textContent = '';
        const addLink = (label, target) => {
            const a = document.createElement('a');
            a.href = '#';
            a.textContent = label;
            a.addEventListener('click', (e) => { e.preventDefault(); loadDirectory(target); });
            breadcrumbEl.appendChild(a);
        };
        addLink('/', '');
        let acc = '';
        (dir ? dir.split('/') : []).forEach((part) => {
            acc = acc ? acc + '/' + part : part;
            addLink(part, acc);
            breadcrumbEl.appendChild(document.createTextNode(' / '));
        });
    }

    function markActive() {
        fileListEl.querySelectorAll('li[data-path]').forEach((li) => {
            li.classList.toggle('active', !!currentFile && li.dataset.path === currentFile && li.dataset.dir !== '1');
        });
    }

    async function loadDirectory(dir) {
        const seq = ++loadSeq;
        currentDir = dir;
        renderBreadcrumb(dir);
        fileListEl.innerHTML = '<li>読み込み中...</li>';

        try {
            const data = await api('cfm_list_files', { dir });
            if (seq !== loadSeq) return;
            fileListEl.innerHTML = '';
            data.items.forEach((item) => {
                const li = document.createElement('li');
                li.dataset.path = item.path;
                li.dataset.dir = item.is_dir ? '1' : '0';
                if (item.is_dir) li.classList.add('is-dir');

                const nameSpan = document.createElement('span');
                nameSpan.className = 'cfm-item-name';
                nameSpan.textContent = (item.is_dir ? '📁 ' : '📄 ') + item.name;
                li.appendChild(nameSpan);

                li.addEventListener('click', () => {
                    if (item.is_dir) loadDirectory(item.path);
                    else loadFileContent(item.path);
                });

                if (!item.is_parent) {
                    const delBtn = document.createElement('button');
                    delBtn.type = 'button';
                    delBtn.textContent = '削除';
                    delBtn.className = 'delete-btn';
                    delBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        deleteItem(item.path, item.name, item.is_dir);
                    });
                    li.appendChild(delBtn);
                }
                fileListEl.appendChild(li);
            });
            markActive();
        } catch (err) {
            if (seq !== loadSeq) return;
            fileListEl.innerHTML = '';
            const li = document.createElement('li');
            li.className = 'cfm-error';
            li.textContent = err.message;
            fileListEl.appendChild(li);
        }
    }

    /* ------------------------------------------------------------
     * ファイル読み込み・保存
     * ---------------------------------------------------------- */
    async function loadFileContent(file) {
        if (dirty && file !== currentFile && !confirm('未保存の変更があります。破棄して別のファイルを開きますか？')) {
            return;
        }
        try {
            const data = await api('cfm_get_file', { file });
            currentFile = file;
            currentFileEl.textContent = '編集中: ' + file;
            currentEol = data.content.indexOf('\r\n') !== -1 ? '\r\n' : '\n';

            loadingContent = true;
            editor.setMode(modeFor(file));
            editor.setValue(data.content);
            editor.setReadOnly(false);
            loadingContent = false;

            dirty = false;
            saveBtn.disabled = false;
            setStatus('', '');
            markActive();
        } catch (err) {
            loadingContent = false;
            alert(err.message);
        }
    }

    async function saveFile() {
        if (!currentFile || saveBtn.disabled) return;
        saveBtn.disabled = true;
        setStatus('保存中...', '');

        let value = editor.getValue();
        if (currentEol === '\r\n') value = value.replace(/\r?\n/g, '\r\n');

        try {
            const msg = await api('cfm_save_file', { file: currentFile, content: value });
            dirty = false;
            setStatus(msg, 'ok');
            setTimeout(() => { if (!dirty) setStatus('', ''); }, 3000);
        } catch (err) {
            setStatus('', '');
            alert(err.message);
        } finally {
            saveBtn.disabled = false;
        }
    }

    saveBtn.addEventListener('click', saveFile);

    /* ------------------------------------------------------------
     * 作成・削除
     * ---------------------------------------------------------- */
    createFileBtn.addEventListener('click', () => createItem('file'));
    createDirBtn.addEventListener('click', () => createItem('dir'));
    newNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); createItem('file'); }
    });

    async function createItem(type) {
        const name = newNameInput.value.trim();
        if (!name) {
            alert('名前を入力してください。');
            return;
        }
        try {
            await api('cfm_create_item', { dir: currentDir, name, type });
            newNameInput.value = '';
            loadDirectory(currentDir);
        } catch (err) {
            alert(err.message);
        }
    }

    async function deleteItem(path, name, isDir) {
        const lines = ['「' + path + '」を削除します。', 'この操作は元に戻せません。'];
        if (isDir) lines.splice(1, 0, 'フォルダ内のファイル・サブフォルダもすべて削除されます。');
        const confirmed = await showConfirm({
            title: (isDir ? 'フォルダ' : 'ファイル') + 'を削除しますか？',
            lines,
            okLabel: '削除する',
            danger: true
        });
        if (!confirmed) return;
        try {
            await api('cfm_delete_item', { path });
            if (currentFile && (currentFile === path || currentFile.indexOf(path + '/') === 0)) {
                currentFile = '';
                dirty = false;
                currentFileEl.textContent = 'ファイルを選択してください';
                loadingContent = true;
                editor.setValue('');
                editor.setReadOnly(true);
                loadingContent = false;
                saveBtn.disabled = true;
                setStatus('', '');
            }
            loadDirectory(currentDir);
        } catch (err) {
            alert(err.message);
        }
    }

    /* ------------------------------------------------------------
     * アップロード（1ファイルずつ順次送信）
     * ---------------------------------------------------------- */
    function setUploadBusy(busy) {
        uploading = busy;
        uploadFilesBtn.disabled = busy;
        uploadFolderBtn.disabled = busy;
    }

    async function uploadItems(items) {
        if (!items.length) return;
        if (uploading) {
            alert('アップロード中です。完了するまでお待ちください。');
            return;
        }
        setUploadBusy(true);

        const targetDir = currentDir;
        let ok = 0;
        const errors = [];

        for (let i = 0; i < items.length; i++) {
            uploadStatusEl.textContent = 'アップロード中 (' + (i + 1) + '/' + items.length + '): ' + items[i].path;
            try {
                await api('cfm_upload_file', { dir: targetDir, path: items[i].path }, items[i].file);
                ok++;
            } catch (err) {
                errors.push(items[i].path + ' … ' + err.message);
            }
        }

        setUploadBusy(false);
        uploadStatusEl.textContent = ok + '件アップロードしました' + (errors.length ? '（失敗 ' + errors.length + '件）' : '。');
        setTimeout(() => { if (!uploading) uploadStatusEl.textContent = uploadHint; }, 6000);

        if (errors.length) {
            alert('アップロードに失敗したファイル:\n\n' + errors.slice(0, 10).join('\n') + (errors.length > 10 ? '\n...他 ' + (errors.length - 10) + '件' : ''));
        }
        if (currentDir === targetDir) loadDirectory(targetDir);
    }

    function fromFileList(fileList) {
        return Array.from(fileList).map((f) => ({
            file: f,
            path: f.webkitRelativePath || f.name
        }));
    }

    uploadFilesBtn.addEventListener('click', () => uploadFilesInput.click());
    uploadFolderBtn.addEventListener('click', () => uploadFolderInput.click());

    uploadFilesInput.addEventListener('change', () => {
        const items = fromFileList(uploadFilesInput.files);
        uploadFilesInput.value = '';
        uploadItems(items);
    });
    uploadFolderInput.addEventListener('change', () => {
        const items = fromFileList(uploadFolderInput.files);
        uploadFolderInput.value = '';
        uploadItems(items);
    });

    /* ドラッグ＆ドロップ（フォルダ対応） */
    function readAllEntries(reader) {
        return new Promise((resolve, reject) => {
            const all = [];
            const next = () => reader.readEntries((entries) => {
                if (!entries.length) return resolve(all);
                all.push(...entries);
                next();
            }, reject);
            next();
        });
    }

    async function walkEntry(entry, prefix, out) {
        if (entry.isFile) {
            const file = await new Promise((res, rej) => entry.file(res, rej));
            out.push({ file, path: prefix + entry.name });
        } else if (entry.isDirectory) {
            const children = await readAllEntries(entry.createReader());
            for (const child of children) {
                await walkEntry(child, prefix + entry.name + '/', out);
            }
        }
    }

    ['dragenter', 'dragover'].forEach((ev) => {
        treeEl.addEventListener(ev, (e) => {
            if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
            e.preventDefault();
            treeEl.classList.add('drag-over');
        });
    });
    treeEl.addEventListener('dragleave', (e) => {
        if (e.target === treeEl || !treeEl.contains(e.relatedTarget)) treeEl.classList.remove('drag-over');
    });
    treeEl.addEventListener('drop', async (e) => {
        e.preventDefault();
        treeEl.classList.remove('drag-over');
        if (!e.dataTransfer) return;

        // await より前に同期的に entry を取得しておく必要がある
        const dtItems = Array.from(e.dataTransfer.items || []);
        const entries = dtItems
            .map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
            .filter(Boolean);

        const out = [];
        try {
            if (entries.length) {
                for (const entry of entries) await walkEntry(entry, '', out);
            } else {
                out.push(...fromFileList(e.dataTransfer.files));
            }
        } catch (err) {
            alert('ドロップされた項目を読み込めませんでした: ' + err.message);
            return;
        }
        uploadItems(out);
    });

    // ウィンドウ外へのドロップでブラウザがファイルを開いてしまうのを防ぐ
    window.addEventListener('dragover', (e) => {
        if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
        if (!treeEl.contains(e.target)) e.preventDefault();
    });

    window.addEventListener('beforeunload', (e) => {
        if (dirty) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    loadDirectory('');
});