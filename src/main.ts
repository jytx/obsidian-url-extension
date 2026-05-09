import { Plugin, WorkspaceLeaf, FileView, TFile, PluginSettingTab, App, Setting, normalizePath, TFolder, requestUrl } from "obsidian";

interface UrlViewerSettings {
    openInBrowser: boolean;
    fullscreenMode: boolean;
    autoFetchTitle: boolean;
}

const DEFAULT_SETTINGS: UrlViewerSettings = {
    openInBrowser: false,
    fullscreenMode: false,
    autoFetchTitle: false
}

const VIEW_TYPE_WEB = "url-webview";

// Did not find the right type for webview in obsidian.d.ts
// So i need this to by pass automatic scan for publishing
type WebviewTag = HTMLElement & {
    src: string;
    reload: () => void;
    goBack: () => void;
    goForward: () => void;
    canGoBack: () => boolean;
    canGoForward: () => boolean;
};

export default class UrlInternalViewerPlugin extends Plugin {
    settings: UrlViewerSettings;

    async onload() {
        await this.loadSettings();
        this.registerView(VIEW_TYPE_WEB, (leaf) => new UrlWebView(leaf, this));
        this.registerExtensions(["url"], VIEW_TYPE_WEB);
        this.addSettingTab(new UrlViewerSettingTab(this.app, this));
        this.addCreateUrlFileShortcuts();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.refreshViews();
    }

    private refreshViews() {
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof UrlWebView) {
                const view = leaf.view as UrlWebView;
                view.updateFullscreenMode();
                view.updateFetchTitleBtn();
            }
        });
    }

    private addCreateUrlFileShortcuts() {
        this.addRibbonIcon('link-2', 'Create .url file', async () => await this.createAndEditUrlFile());

        this.addCommand({
            id: "create-url-file",
            name: "Create .url file",
            callback: async () => await this.createAndEditUrlFile(),
        });

        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file, _source) => {
                if (file instanceof TFolder) {
                    menu.addItem((item) =>
                        item
                            .setTitle("Create .url file")
                            .setIcon("link-2")
                            .onClick(async () => await this.createAndEditUrlFile(file.path + "/URL " + Date.now() + ".url"))
                    );
                } else if (file instanceof TFile) {
                    menu.addItem((item) =>
                        item
                            .setTitle("Create .url file")
                            .setIcon("link-2")
                            .onClick(async () => {
                                const parentPath = file.parent?.path ?? "";
                                await this.createAndEditUrlFile(parentPath + "/URL " + Date.now() + ".url");
                            })
                    );
                    if (file.extension === 'url') {
                        menu.addItem((item) =>
                            item
                                .setTitle("Edit URL")
                                .setIcon("edit")
                                .onClick(async () => {
                                    const leaf = this.app.workspace.getLeaf(true);
                                    await leaf.openFile(file);
                                    const view = leaf.view;
                                    if (view instanceof UrlWebView) {
                                        view.startEditing(false);
                                    }
                                })
                        );
                    }
                }
            })
        );
    }

    private async createAndEditUrlFile(path?: string) {
        const fileName = `URL ${Date.now()}.url`;
        const content = `[InternetShortcut]\nURL=\n`;
        if (path == null) {
            const activeFile = this.app.workspace.getActiveFile();
            const parentFolder = this.app.fileManager.getNewFileParent(activeFile?.path ?? "");
            path = normalizePath(`${parentFolder.path}/${fileName}`);
        }
        const created = await this.app.vault.create(path, content);
        const leaf = this.app.workspace.getLeaf(true);
        await leaf.openFile(created);
        const view = leaf.view;
        if (view instanceof UrlWebView) {
            view.startEditing(true);
        }
    }
}

class UrlWebView extends FileView {
    private plugin: UrlInternalViewerPlugin;
    private isEditing: boolean = false;
    private headerHidden: boolean = false;
    private webviewEl: WebviewTag | null = null;
    private backActionEl: HTMLElement | null = null;
    private forwardActionEl: HTMLElement | null = null;
    private deleteOnCancelIfUntouched: boolean = false;

    constructor(leaf: WorkspaceLeaf, plugin: UrlInternalViewerPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    private get settings() {
        return this.plugin.settings;
    }

    private extractUrl(content: string): string {
        let url = content.trim();
        if (content.includes('[InternetShortcut]')) {
            const match = content.match(/URL=(.+)/);
            if (match) url = match[1].trim();
        }
        return this.normalizeUrl(url);
    }

    getViewType(): string {
        return VIEW_TYPE_WEB;
    }

    getDisplayText(): string {
        return this.file?.basename || "URL Viewer";
    }

    protected async onOpen(): Promise<void> {
        this.containerEl.addClass("url-webview-opener");
        this.updateFullscreenMode();
        this.addAction("edit", "Edit URL", () => this.toggleEditMode());
        this.addAction("external-link", "Open in browser", () => this.openInBrowser());
        this.addAction("refresh-cw", "Reload", () => this.webviewReload());
        this.addAction("arrow-right", "Forward", () => this.webviewGoForward());
        this.addAction("arrow-left", "Back", () => this.webviewGoBack());
    }

    updateFullscreenMode() {
        if (this.settings.fullscreenMode) {
            this.containerEl.addClass("fullscreen-mode");
            this.headerHidden = true;
            this.containerEl.addClass("header-hidden");
        } else {
            this.containerEl.removeClass("fullscreen-mode");
            this.headerHidden = false;
            this.containerEl.removeClass("header-hidden");
        }
    }

    updateFetchTitleBtn() {
        const btn = this.containerEl.querySelector(".btn-fetch-title");
        if (!btn) return;
        if (this.plugin.settings.autoFetchTitle) {
            btn.addClass("btn-fetch-title-hidden");
        } else {
            btn.removeClass("btn-fetch-title-hidden");
        }
    }

    async onLoadFile(file: TFile): Promise<void> {
        const content = await this.app.vault.read(file);
        const url = this.extractUrl(content);
        setTimeout(() => {
            if (this.isEditing || !isValidUrl(url)) {
                this.showEditMode(file, content);
            } else {
                if (this.settings.openInBrowser) {
                    window.open(url, "_blank");
                    this.leaf.detach();
                    return;
                } else {
                    this.showViewMode(url);
                }
            }
        }, 0);
    }

    private updateActionStates() {
        if (!isWebviewTag(this.webviewEl)) return;
        if (this.backActionEl) {
            const canGoBack = this.webviewEl.canGoBack();
            this.backActionEl.toggleClass("is-disabled", !canGoBack);
        }
        if (this.forwardActionEl) {
            const canGoForward = this.webviewEl.canGoForward();
            this.forwardActionEl.toggleClass("is-disabled", !canGoForward);
        }
    }

    private webviewGoBack() {
        if (isWebviewTag(this.webviewEl)) this.webviewEl.goBack();
    }
    private webviewGoForward() {
        if (isWebviewTag(this.webviewEl)) this.webviewEl.goForward();
    }
    private webviewReload() {
        if (isWebviewTag(this.webviewEl)) this.webviewEl.reload();
    }

    private showViewMode(url: string) {
        const container = this.containerEl.children[1];
        container.empty();

        const webviewEl = document.createElement("webview");
        if (!isWebviewTag(webviewEl)) {
            console.error("webviewEl is not a WebviewTag");
            return;
        }

        webviewEl.src = url;
        webviewEl.setAttribute("style", "width:100%;height:100%;");
        container.appendChild(webviewEl);
        this.webviewEl = webviewEl;

        const actions = this.containerEl.querySelectorAll('.view-action');
        this.backActionEl = actions[0] as HTMLElement;
        this.forwardActionEl = actions[1] as HTMLElement;

        const updateNav = () => this.updateActionStates();
        webviewEl.addEventListener("did-navigate", updateNav);
        webviewEl.addEventListener("did-navigate-in-page", updateNav);
        webviewEl.addEventListener("dom-ready", updateNav);

        if (this.settings.fullscreenMode) {
            const chevron = container.createEl("div", {
                cls: "chevron-toggle",
                text: "⟩"
            });
            chevron.onclick = () => this.toggleHeader();
        }
    }

    private toggleHeader() {
        this.headerHidden = !this.headerHidden;
        if (this.headerHidden) {
            this.containerEl.addClass("header-hidden");
        } else {
            this.containerEl.removeClass("header-hidden");
        }
        const chevron = this.containerEl.querySelector('.chevron-toggle');
        if (chevron) chevron.textContent = "⟩";
    }

    private showEditMode(file: TFile, content: string) {
        const container = this.containerEl.children[1];
        container.empty();

        const editContainer = container.createDiv("url-webview-opener-edit");
        const textarea = editContainer.createEl("textarea", { cls: "url-textarea" });
        textarea.value = content;

        const btnContainer = editContainer.createDiv("url-edit-buttons");

        const fetchTitleBtn = btnContainer.createEl("button", { text: "Get Url Title", cls: "btn-edit btn-fetch-title" });
        if (this.plugin.settings.autoFetchTitle) {
            fetchTitleBtn.addClass("btn-fetch-title-hidden");
        }
        fetchTitleBtn.onclick = async () => {
            const urlFromTextarea = this.extractUrl(textarea.value);
            if (!urlFromTextarea || !isValidUrl(urlFromTextarea)) {
                fetchTitleBtn.textContent = "URL Invalid";
                setTimeout(() => { fetchTitleBtn.textContent = "Get Url Title"; }, 2000);
                return;
            }
            fetchTitleBtn.textContent = "Loading...";
            fetchTitleBtn.disabled = true;
            const title = await this.fetchUrlTitle(urlFromTextarea);
            if (title) {
                // Rename file with the fetched title
                const parentPath = file.parent?.path ?? "/";
                const newFileName = this.findUniqueFilePath(parentPath, title);
                await this.app.fileManager.renameFile(file, newFileName);
                fetchTitleBtn.textContent = "Find URL Title";
            } else {
                fetchTitleBtn.textContent = "Not Find URL Title";
            }
            setTimeout(() => {
                fetchTitleBtn.textContent = "Get Url Title";
                fetchTitleBtn.disabled = false;
            }, 2000);
        };

        const saveBtn = btnContainer.createEl("button", { text: "Save", cls: "btn-edit" });
        saveBtn.onclick = async () => {
            await this.app.vault.modify(file, textarea.value);

            // Auto-fetch title for newly created files
            if (this.deleteOnCancelIfUntouched && this.plugin.settings.autoFetchTitle) {
                const urlFromTextarea = this.extractUrl(textarea.value);
                if (urlFromTextarea && isValidUrl(urlFromTextarea)) {
                    // Show loading state
                    const allBtns = btnContainer.querySelectorAll("button");
                    allBtns.forEach((btn) => { (btn as HTMLButtonElement).disabled = true; });
                    saveBtn.textContent = "Saving...";

                    const title = await this.fetchUrlTitle(urlFromTextarea);
                    if (title) {
                        const parentPath = file.parent?.path ?? "/";
                        const newFileName = this.findUniqueFilePath(parentPath, title);
                        await this.app.fileManager.renameFile(file, newFileName);
                    }
                }
            }

            this.deleteOnCancelIfUntouched = false;
            this.isEditing = false;
            await this.onLoadFile(file);
        };

        const cancelBtn = btnContainer.createEl("button", { text: "Cancel", cls: "btn-edit" });
        cancelBtn.onclick = async () => {
            if (this.deleteOnCancelIfUntouched) {
                const currentContent = await this.app.vault.read(file);
                if (this.isEmptyUrlContent(currentContent)) {
                    await this.app.vault.delete(file);
                    this.isEditing = false;
                    this.deleteOnCancelIfUntouched = false;
                    this.leaf.detach();
                    return;
                }
            }
            this.isEditing = false;
            this.deleteOnCancelIfUntouched = false;
            this.onLoadFile(file);
        };
    }

    /** Sanitize file name by replacing illegal characters (/ \ : * ? " < > |) with "-" */
    private sanitizeFileName(name: string): string {
        return name.replace(/[/\\:*?"<>|]/g, "-").trim();
    }

    /** Generate a unique file path, appending (1), (2), etc. if the name already exists */
    private findUniqueFilePath(parentPath: string, baseName: string): string {
        const ext = ".url";
        const safeName = this.sanitizeFileName(baseName);
        let candidate = normalizePath(`${parentPath}/${safeName}${ext}`);
        let index = 1;
        while (this.app.vault.getAbstractFileByPath(candidate)) {
            candidate = normalizePath(`${parentPath}/${safeName} (${index})${ext}`);
            index++;
        }
        return candidate;
    }

    private normalizeUrl(url: string): string {
        const trimmed = url.trim();
        if (!trimmed) return trimmed;
        if (/^[a-zA-Z][a-zA-Z0-9+.+-]*:/.test(trimmed)) return trimmed;
        const withoutSlashes = trimmed.replace(/^\/\//, "");
        return `https://${withoutSlashes}`;
    }

    /** Extract page title from HTML with priority: og:title > twitter:title > <title> */
    private extractTitleFromHtml(html: string): string | null {
        const ogMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)
            ?? html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:title["']/i);
        if (ogMatch && ogMatch[1].trim()) return ogMatch[1].trim();

        const twMatch = html.match(/<meta\s+(?:name|property)=["']twitter:title["']\s+content=["']([^"']+)["']/i)
            ?? html.match(/<meta\s+content=["']([^"']+)["']\s+(?:name|property)=["']twitter:title["']/i);
        if (twMatch && twMatch[1].trim()) return twMatch[1].trim();

        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch && titleMatch[1].trim()) return titleMatch[1].trim();

        return null;
    }

    /**
     * Fetch page title from a URL.
     * Strategy 1: requestUrl to fetch HTML and extract title directly (fast, works for most sites)
     * Strategy 2: hidden webview to render the page and extract title (fallback for anti-bot sites)
     */
    private async fetchUrlTitle(url: string): Promise<string | null> {
        const normalized = this.normalizeUrl(url);

        try {
            const response = await requestUrl({ url: normalized, method: "GET" });
            const html = response.text;
            const title = this.extractTitleFromHtml(html);
            if (title) return title;
        } catch {
            // requestUrl failed, fall back to webview approach
        }

        return this.fetchUrlTitleViaWebview(normalized);
    }

    /** Fetch page title using a hidden webview (fallback for anti-bot sites) */
    private fetchUrlTitleViaWebview(url: string): Promise<string | null> {
        return new Promise<string | null>((resolve) => {
            const hiddenWebview = document.createElement("webview") as WebviewTag & {
                executeJavaScript: (code: string) => Promise<string>;
            };
            hiddenWebview.style.cssText = "width:1px;height:1px;position:absolute;left:-9999px;opacity:0;";

            let settled = false;

            const timeout = setTimeout(() => {
                cleanup();
                resolve(null);
            }, 15000);

            const cleanup = () => {
                clearTimeout(timeout);
                hiddenWebview.removeEventListener("did-finish-load", onLoad);
                hiddenWebview.removeEventListener("did-fail-load", onFail);
                hiddenWebview.remove();
            };

            const finish = (title: string | null) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(title);
            };

            const extractTitleScript = `
                (function() {
                    const og = document.querySelector('meta[property="og:title"]');
                    if (og && og.getAttribute('content')) return og.getAttribute('content');
                    const h1 = document.querySelector('h1');
                    if (h1 && h1.textContent && h1.textContent.trim().length > 1) return h1.textContent.trim();
                    return document.title || '';
                })()
            `;

            const onLoad = async () => {
                await new Promise(r => setTimeout(r, 3000));
                if (settled) return;
                try {
                    const title = await hiddenWebview.executeJavaScript(extractTitleScript);
                    finish(title?.trim() || null);
                } catch {
                    finish(null);
                }
            };

            const onFail = () => {
                finish(null);
            };

            hiddenWebview.addEventListener("did-finish-load", onLoad);
            hiddenWebview.addEventListener("did-fail-load", onFail);
            hiddenWebview.src = url;
            document.body.appendChild(hiddenWebview);
        });
    }

    public startEditing(deleteOnCancelIfUntouched: boolean = false) {
        this.isEditing = true;
        this.deleteOnCancelIfUntouched = deleteOnCancelIfUntouched;
        if (this.file != null) this.onLoadFile(this.file);
    }

    private isEmptyUrlContent(content: string): boolean {
        const trimmed = content.trim();
        if (trimmed.length === 0) return true;
        if (trimmed.includes('[InternetShortcut]')) {
            const match = content.match(/URL=(.*)/);
            if (!match) return true;
            const value = (match[1] ?? '').trim();
            return value.length === 0;
        }
        return trimmed.length === 0;
    }

    private toggleEditMode() {
        this.isEditing = !this.isEditing;
        if (this.file) this.onLoadFile(this.file);
    }

    private async openInBrowser() {
        if (this.file) {
            const content = await this.app.vault.read(this.file);
            const url = this.extractUrl(content);
            window.open(url, "_blank");
        }
    }
}

class UrlViewerSettingTab extends PluginSettingTab {
    plugin: UrlInternalViewerPlugin;

    constructor(app: App, plugin: UrlInternalViewerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Open in browser by default')
            .setDesc('Open URL files directly in browser instead of webview')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.openInBrowser)
                .onChange(async (value) => {
                    this.plugin.settings.openInBrowser = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Fullscreen mode')
            .setDesc('Hide toolbar and show floating navigation buttons for maximum space')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.fullscreenMode)
                .onChange(async (value) => {
                    this.plugin.settings.fullscreenMode = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Get Url Title')
            .setDesc('Show a "Get Url Title" button in edit mode to fetch the page title and rename the file')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoFetchTitle)
                .onChange(async (value) => {
                    this.plugin.settings.autoFetchTitle = value;
                    await this.plugin.saveSettings();
                }));
    }
}

function isWebviewTag(el: unknown): el is WebviewTag {
    return (
        !!el &&
        typeof (el as WebviewTag).reload === "function" &&
        typeof (el as WebviewTag).goBack === "function" &&
        typeof (el as WebviewTag).goForward === "function"
    );
}

function isValidUrl(url: string): boolean {
    try {
        new URL(url);
        return true;
    } catch (error) {
        return false;
    }
}
