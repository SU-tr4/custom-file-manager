<?php
/**
 * Plugin Name: Custom File Manager
 * Description: 階層アップロード・シンタックスハイライト搭載のファイルマネージャー
 * Version: 1.6.1
 * Author: Tera
 */

if (!defined('ABSPATH')) {
    exit;
}

class Custom_File_Manager {

    const VERSION      = '1.6.0';
    const NONCE_ACTION = 'cfm_nonce';
    const MAX_EDIT_SIZE = 2097152; // 2MB 超のファイルはエディタで開かない

    private $root_dir;

    public function __construct() {
        $real = realpath(ABSPATH);
        $this->root_dir = untrailingslashit(wp_normalize_path($real ? $real : ABSPATH));

        add_action('admin_menu', [$this, 'add_admin_menu']);
        add_action('admin_enqueue_scripts', [$this, 'enqueue_assets']);

        add_action('wp_ajax_cfm_list_files', [$this, 'ajax_list_files']);
        add_action('wp_ajax_cfm_get_file', [$this, 'ajax_get_file']);
        add_action('wp_ajax_cfm_save_file', [$this, 'ajax_save_file']);
        add_action('wp_ajax_cfm_create_item', [$this, 'ajax_create_item']);
        add_action('wp_ajax_cfm_delete_item', [$this, 'ajax_delete_item']);
        add_action('wp_ajax_cfm_upload_file', [$this, 'ajax_upload_file']);
    }

    public function add_admin_menu() {
        add_management_page(
            'Custom File Manager',
            'ファイルマネージャー',
            'manage_options',
            'custom-file-manager',
            [$this, 'render_admin_page']
        );
    }

    public function enqueue_assets($hook) {
        if ($hook !== 'tools_page_custom-file-manager') {
            return;
        }

        // WordPress 標準の CodeMirror を利用（ユーザープロフィールで無効化されている場合は false）
        $editor_settings = wp_enqueue_code_editor(['type' => 'text/html']);

        $script_deps = [];
        $style_deps  = [];
        if ($editor_settings !== false) {
            $script_deps = ['code-editor'];
            $style_deps  = ['wp-codemirror'];
        }

        wp_enqueue_style('cfm-style-css', plugins_url('cfm-style.css', __FILE__), $style_deps, self::VERSION);
        wp_enqueue_script('custom-file-manager-js', plugins_url('editor.js', __FILE__), $script_deps, self::VERSION, true);

        $config = [
            'ajaxUrl'        => admin_url('admin-ajax.php'),
            'nonce'          => wp_create_nonce(self::NONCE_ACTION),
            'editorSettings' => $editor_settings ? $editor_settings : null,
        ];
        wp_add_inline_script(
            'custom-file-manager-js',
            'window.cfmConfig = ' . wp_json_encode($config) . ';',
            'before'
        );
    }

    public function render_admin_page() {
        ?>
        <div class="wrap">
            <h1>Custom File Manager</h1>
            <div class="cfm-wrap">
                <div class="cfm-file-panel">
                    <div id="cfm-breadcrumb" class="cfm-breadcrumb">/</div>
                    <div class="cfm-toolbar">
                        <input type="text" id="cfm-new-name" placeholder="新規ファイル名またはフォルダ名">
                        <button type="button" id="cfm-create-file-btn" class="button">ファイル作成</button>
                        <button type="button" id="cfm-create-dir-btn" class="button">フォルダ作成</button>
                    </div>
                    <div class="cfm-tree-container" id="cfm-tree-container">
                        <ul id="cfm-file-list" class="cfm-file-list"><li>読み込み中...</li></ul>
                    </div>
                    <div class="cfm-upload-box">
                        <input type="file" id="cfm-upload-files" multiple hidden>
                        <input type="file" id="cfm-upload-folder" multiple webkitdirectory hidden>
                        <button type="button" id="cfm-upload-files-btn" class="button">ファイルをアップロード</button>
                        <button type="button" id="cfm-upload-folder-btn" class="button">フォルダをアップロード</button>
                    </div>
                    <div id="cfm-upload-status" class="cfm-upload-status">ファイル／フォルダをここにドラッグ＆ドロップでもアップロードできます</div>
                </div>
                <div class="cfm-editor-area">
                    <h3 id="cfm-current-file">ファイルを選択してください</h3>

                    <div class="cfm-editor-container" id="cfm-editor-container">
                        <textarea id="cfm-file-content" class="cfm-fallback-textarea" placeholder="ここにコードが表示されます" spellcheck="false" disabled></textarea>
                    </div>

                    <div class="cfm-actions">
                        <span id="cfm-status" class="cfm-status"></span>
                        <button type="button" id="cfm-save-btn" class="button button-primary" disabled>保存する (Ctrl+S)</button>
                    </div>
                </div>
            </div>
        </div>
        <?php
    }

    /* ---------------------------------------------------------------
     * ヘルパー
     * ------------------------------------------------------------- */

    /** 権限・nonce チェック */
    private function guard() {
        if (!current_user_can('manage_options')) {
            wp_send_json_error('権限がありません。', 403);
        }
        if (!check_ajax_referer(self::NONCE_ACTION, 'nonce', false)) {
            wp_send_json_error('セキュリティチェックに失敗しました。ページを再読み込みしてください。', 403);
        }
    }

    /**
     * 相対パスを正規化する。".." を含む場合は false。
     * ※ WordPress は $_POST に自動でスラッシュを付加するため unslash が必須
     */
    private function normalize_rel($path) {
        $path = wp_unslash((string) $path);
        $path = preg_replace('/[\x00-\x1F\x7F]/', '', $path);
        $path = str_replace('\\', '/', $path);

        $segments = [];
        foreach (explode('/', $path) as $seg) {
            if ($seg === '' || $seg === '.') {
                continue;
            }
            if ($seg === '..') {
                return false;
            }
            $segments[] = $seg;
        }
        return implode('/', $segments);
    }

    private function abs_from_rel($rel) {
        return $rel === '' ? $this->root_dir : $this->root_dir . '/' . $rel;
    }

    private function join_rel($dir, $name) {
        return $dir === '' ? $name : $dir . '/' . $name;
    }

    private function upload_error_message($code) {
        switch ($code) {
            case UPLOAD_ERR_INI_SIZE:
                return 'ファイルサイズが upload_max_filesize (' . ini_get('upload_max_filesize') . ') を超えています。';
            case UPLOAD_ERR_FORM_SIZE:
                return 'ファイルサイズが上限を超えています。';
            case UPLOAD_ERR_PARTIAL:
                return 'ファイルが一部しかアップロードされませんでした。';
            case UPLOAD_ERR_NO_FILE:
                return 'ファイルがありません。';
            case UPLOAD_ERR_NO_TMP_DIR:
                return 'サーバーの一時フォルダがありません。';
            case UPLOAD_ERR_CANT_WRITE:
                return 'サーバーへの書き込みに失敗しました。';
            default:
                return 'アップロードエラー (code: ' . (int) $code . ')';
        }
    }

    /* ---------------------------------------------------------------
     * AJAX
     * ------------------------------------------------------------- */

    public function ajax_list_files() {
        $this->guard();

        $dir = $this->normalize_rel($_POST['dir'] ?? '');
        if ($dir === false) {
            wp_send_json_error('無効なディレクトリです。');
        }
        $safe_path = $this->abs_from_rel($dir);
        if (!is_dir($safe_path)) {
            wp_send_json_error('無効なディレクトリです。');
        }

        $items = [];
        if ($dir !== '') {
            $parent = dirname($dir);
            if ($parent === '.' || $parent === '/' || $parent === '\\') {
                $parent = '';
            }
            $items[] = [
                'name'      => '.. [ ひとつ上の階層へ ]',
                'path'      => $parent,
                'is_dir'    => true,
                'is_parent' => true,
            ];
        }

        $entries = @scandir($safe_path);
        if ($entries === false) {
            wp_send_json_error('ディレクトリを読み取れません。（権限を確認してください）');
        }
        foreach ($entries as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $items[] = [
                'name'      => $entry,
                'path'      => $this->join_rel($dir, $entry),
                'is_dir'    => is_dir($safe_path . '/' . $entry),
                'is_parent' => false,
            ];
        }

        usort($items, function ($a, $b) {
            if ($a['is_parent']) return -1;
            if ($b['is_parent']) return 1;
            if ($a['is_dir'] === $b['is_dir']) {
                return strcasecmp($a['name'], $b['name']);
            }
            return $a['is_dir'] ? -1 : 1;
        });

        wp_send_json_success(['items' => $items, 'current_dir' => $dir]);
    }

    public function ajax_get_file() {
        $this->guard();

        $file = $this->normalize_rel($_POST['file'] ?? '');
        if ($file === false || $file === '') {
            wp_send_json_error('ファイルが見つかりません。');
        }
        $safe_path = $this->abs_from_rel($file);
        if (!is_file($safe_path)) {
            wp_send_json_error('ファイルが見つかりません。');
        }
        if (filesize($safe_path) > self::MAX_EDIT_SIZE) {
            wp_send_json_error('ファイルが大きすぎるため開けません（上限 2MB）。');
        }

        $content = file_get_contents($safe_path);
        if ($content === false) {
            wp_send_json_error('ファイルを読み込めません。');
        }
        if ($content !== '' && !preg_match('//u', $content)) {
            wp_send_json_error('UTF-8 以外の文字コード、またはバイナリファイルは編集できません。');
        }

        wp_send_json_success(['content' => $content, 'file' => $file]);
    }

    public function ajax_save_file() {
        $this->guard();

        $file = $this->normalize_rel($_POST['file'] ?? '');
        if ($file === false || $file === '') {
            wp_send_json_error('ファイルが見つかりません。');
        }
        $safe_path = $this->abs_from_rel($file);
        if (!is_file($safe_path)) {
            wp_send_json_error('ファイルが見つかりません。');
        }

        // ★ unslash しないと「'」「"」「\」の前にバックスラッシュが付いて保存される
        $content = wp_unslash($_POST['content'] ?? '');

        if (file_put_contents($safe_path, $content) !== false) {
            wp_send_json_success('ファイルを保存しました。');
        }
        wp_send_json_error('ファイルの書き込みに失敗しました。（書き込み権限を確認してください）');
    }

    public function ajax_create_item() {
        $this->guard();

        $dir  = $this->normalize_rel($_POST['dir'] ?? '');
        $name = $this->normalize_rel($_POST['name'] ?? '');
        $type = sanitize_key($_POST['type'] ?? 'file');

        if ($dir === false || $name === false || $name === '') {
            wp_send_json_error('名前が空、または無効です。');
        }

        $target = $this->abs_from_rel($this->join_rel($dir, $name));
        if (file_exists($target)) {
            wp_send_json_error('すでに存在しています。');
        }

        if ($type === 'dir') {
            if (wp_mkdir_p($target)) {
                wp_send_json_success('フォルダを作成しました。');
            }
            wp_send_json_error('フォルダの作成に失敗しました。');
        }

        $parent = dirname($target);
        if (!is_dir($parent) && !wp_mkdir_p($parent)) {
            wp_send_json_error('親フォルダの作成に失敗しました。');
        }
        if (file_put_contents($target, '') !== false) {
            wp_send_json_success('ファイルを作成しました。');
        }
        wp_send_json_error('ファイルの作成に失敗しました。');
    }

    public function ajax_delete_item() {
        $this->guard();

        $rel = $this->normalize_rel($_POST['path'] ?? '');
        if ($rel === false || $rel === '') {
            wp_send_json_error('このアイテムは削除できません。');
        }
        $safe_path = $this->abs_from_rel($rel);

        $plugin_dir  = untrailingslashit(wp_normalize_path(plugin_dir_path(__FILE__)));
        $plugin_file = wp_normalize_path(__FILE__);
        if ($safe_path === $plugin_file || $safe_path === $plugin_dir) {
            wp_send_json_error('このプラグイン本体は削除できません。');
        }

        if (is_link($safe_path) || is_file($safe_path)) {
            if (@unlink($safe_path)) {
                wp_send_json_success('ファイルを削除しました。');
            }
            wp_send_json_error('ファイルを削除できませんでした。');
        } elseif (is_dir($safe_path)) {
            $this->recursive_delete($safe_path);
            wp_send_json_success('フォルダを削除しました。');
        }
        wp_send_json_error('アイテムが見つかりません。');
    }

    private function recursive_delete($dir) {
        $files = array_diff(scandir($dir), ['.', '..']);
        foreach ($files as $file) {
            $path = $dir . '/' . $file;
            if (is_dir($path) && !is_link($path)) {
                $this->recursive_delete($path);
            } else {
                @unlink($path);
            }
        }
        @rmdir($dir);
    }

    /**
     * 1リクエスト = 1ファイル。
     * （PHP の max_file_uploads=20 / post_max_size の制限を回避するため JS 側から順次送信）
     */
    public function ajax_upload_file() {
        $this->guard();

        $dir  = $this->normalize_rel($_POST['dir'] ?? '');
        $path = $this->normalize_rel($_POST['path'] ?? '');

        if ($dir === false || $path === false) {
            wp_send_json_error('パスが無効です。');
        }
        if (!is_dir($this->abs_from_rel($dir))) {
            wp_send_json_error('アップロード先のディレクトリが無効です。');
        }

        if (empty($_FILES['upload'])) {
            wp_send_json_error(
                'ファイルを受信できませんでした。サイズが post_max_size (' . ini_get('post_max_size') .
                ') / upload_max_filesize (' . ini_get('upload_max_filesize') . ') を超えている可能性があります。'
            );
        }

        $file = $_FILES['upload'];
        if (is_array($file['error'])) {
            wp_send_json_error('不正なリクエストです。');
        }
        if ($file['error'] !== UPLOAD_ERR_OK) {
            wp_send_json_error($this->upload_error_message($file['error']));
        }

        if ($path === '') {
            $path = $this->normalize_rel($file['name']);
        }
        if ($path === false || $path === '') {
            wp_send_json_error('ファイル名が無効です。');
        }

        $destination = $this->abs_from_rel($this->join_rel($dir, $path));
        if (is_dir($destination)) {
            wp_send_json_error('同名のフォルダが存在します。');
        }

        $dest_dir = dirname($destination);
        if (!is_dir($dest_dir) && !wp_mkdir_p($dest_dir)) {
            wp_send_json_error('保存先フォルダを作成できませんでした。');
        }
        if (!is_writable($dest_dir)) {
            wp_send_json_error('保存先フォルダに書き込み権限がありません。');
        }

        if (!move_uploaded_file($file['tmp_name'], $destination)) {
            wp_send_json_error('ファイルの移動に失敗しました。');
        }

        // 一時ファイルは 0600 のため、そのままだと Web サーバーから読めないことがある
        $stat  = @stat($dest_dir);
        $perms = $stat ? ($stat['mode'] & 0000666) : 0644;
        @chmod($destination, $perms);

        wp_send_json_success('アップロードしました。');
    }
}

new Custom_File_Manager();