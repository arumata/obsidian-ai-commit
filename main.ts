import { App, Plugin, PluginSettingTab, Setting, Notice, setIcon, requestUrl } from 'obsidian';
import { execSync } from 'child_process';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
const OLLAMA_DEFAULT_URL = 'http://localhost:11434';
const OLLAMA_DEFAULT_MODEL = 'llama3.1';
const RETRIES = 3;

const DEEPSEEK_MODEL_OPTIONS: Record<string, string> = {
    'deepseek-v4-flash': 'DeepSeek V4 Flash',
    'deepseek-v4-pro': 'DeepSeek V4 Pro',
};

type Provider = 'deepseek' | 'ollama';

const SYSTEM_PROMPT = [
    'You are an expert at writing git commit messages.',
    'Write a short, descriptive commit message in plain language.',
    'Do NOT use Conventional Commits format (no "type:" or "type(scope):" prefixes).',
    'Write ONLY the commit message — no explanations, no markdown fences, no quotes.',
    'Output a complete sentence. Do not truncate mid-word.',
    'Focus on WHAT changed and WHY, not HOW.',
].join('\n');

export interface AICommitSettings {
    provider: Provider;
    apiKey: string;
    model: string;
    ollamaUrl: string;
    ollamaModel: string;
    customPrompt: string;
    timeout: number;
}

interface DeepSeekResponse {
    choices?: Array<{
        message?: {
            content?: string;
        };
    }>;
}

interface OllamaChatResponse {
    message?: {
        content?: string;
    };
}

interface OllamaTagsResponse {
    models?: Array<{
        name?: string;
        model?: string;
    }>;
}

const DEFAULT_SETTINGS: AICommitSettings = {
    provider: 'deepseek',
    apiKey: '',
    model: DEEPSEEK_DEFAULT_MODEL,
    ollamaUrl: OLLAMA_DEFAULT_URL,
    ollamaModel: OLLAMA_DEFAULT_MODEL,
    customPrompt: '',
    timeout: 30000,
};

function cleanMessage(raw: string): string {
    return raw
        .replace(/^```[a-z]*\n?/im, '')
        .replace(/\n?```$/m, '')
        .replace(/^["']|["']$/g, '')
        .replace(/^commit message:\s*/im, '')
        .replace(/^\w+(\([^)]*\))?!?:\s*/i, '')
        .trim();
}

function isError(e: unknown): e is Error {
    return e instanceof Error;
}

function isAbortError(e: unknown): boolean {
    return isError(e) && e.name === 'AbortError';
}

function errorMessage(e: unknown): string {
    if (isError(e)) {
        return e.message;
    }
    if (typeof e === 'string') {
        return e;
    }
    return 'Unknown error';
}

function timeoutPromise(ms: number): Promise<never> {
    return new Promise((_, reject) =>
        window.setTimeout(() => reject(new DOMException('Request timed out', 'AbortError')), ms)
    );
}

function normalizeBaseUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
}

const COMMIT_TEXTAREA_MAX_HEIGHT = 240; // px — roughly 10-12 lines before it scrolls

interface TextareaBinding {
    schedule: () => void;
    dispose: () => void;
}

function bindCommitTextarea(textarea: HTMLTextAreaElement): TextareaBinding {
    const view = textarea.ownerDocument.defaultView ?? window;
    const properties = ['--ai-commit-textarea-height', '--ai-commit-textarea-overflow'];
    const previous = Object.fromEntries(properties.map(name => [name, textarea.style.getPropertyValue(name)]));
    let frame: number | undefined;
    let disposed = false;
    let width = textarea.clientWidth;
    const schedule = () => {
        if (disposed || frame !== undefined) return;
        // Svelte updates rows/value after the input handler has returned.
        frame = view.requestAnimationFrame(() => {
            frame = undefined;
            if (disposed) return;
            textarea.setCssProps({ '--ai-commit-textarea-height': '0px' });
            const contentHeight = textarea.scrollHeight;
            const style = view.getComputedStyle(textarea);
            const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
            const height = Math.min(contentHeight + borders, COMMIT_TEXTAREA_MAX_HEIGHT);
            textarea.setCssProps({
                '--ai-commit-textarea-height': `${height}px`,
                '--ai-commit-textarea-overflow': contentHeight + borders > height ? 'auto' : 'hidden',
            });
        });
    };
    textarea.addClass('ai-commit-autosize');
    textarea.addEventListener('input', schedule);
    textarea.addEventListener('change', schedule);
    const resize = new ResizeObserver(() => {
        if (width !== textarea.clientWidth) {
            width = textarea.clientWidth;
            schedule();
        }
    });
    resize.observe(textarea);
    schedule();
    return {
        schedule,
        dispose: () => {
            disposed = true;
            if (frame !== undefined) view.cancelAnimationFrame(frame);
            resize.disconnect();
            textarea.removeEventListener('input', schedule);
            textarea.removeEventListener('change', schedule);
            textarea.removeClass('ai-commit-autosize');
            textarea.setCssProps(previous);
        },
    };
}

interface GitViewBinding {
    observer: MutationObserver;
    textareas: Map<HTMLTextAreaElement, TextareaBinding>;
}

class AICommitSettingTab extends PluginSettingTab {
    plugin: AICommitPlugin;
    private renderVersion = 0;

    constructor(app: App, plugin: AICommitPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        this.renderSettings();
    }

    private renderSettings(): void {
        this.renderVersion++;
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Provider')
            .setDesc('AI provider used to generate commit messages')
            .addDropdown((dropdown) => {
                dropdown.addOption('deepseek', 'DeepSeek (cloud)');
                dropdown.addOption('ollama', 'Ollama (local)');
                dropdown.setValue(this.plugin.settings.provider);
                dropdown.onChange(async (value) => {
                    this.plugin.settings.provider = value as Provider;
                    await this.plugin.saveSettings();
                    this.renderSettings();
                });
            });

        if (this.plugin.settings.provider === 'ollama') {
            this.displayOllamaSettings(containerEl);
        } else {
            this.displayDeepSeekSettings(containerEl);
        }

        new Setting(containerEl)
            .setName('Timeout')
            .setDesc('API request timeout in seconds')
            .addSlider((slider) => {
                slider
                    .setLimits(10, 120, 5)
                    .setValue(this.plugin.settings.timeout / 1000)
                    .onChange(async (value) => {
                        this.plugin.settings.timeout = value * 1000;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Custom instructions')
            .setDesc('Appended to the system prompt (language, style, extra rules)')
            .addTextArea((text) => {
                text
                    .setPlaceholder('Write concise commit messages')
                    .setValue(this.plugin.settings.customPrompt)
                    .onChange(async (value) => {
                        this.plugin.settings.customPrompt = value.trim();
                        await this.plugin.saveSettings();
                    });
                text.inputEl.rows = 3;
            });
    }

    private displayDeepSeekSettings(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName('DeepSeek API key')
            .setDesc('DeepSeek API key')
            .addText((text) => {
                text
                    .setPlaceholder('Sk-…')
                    .setValue(this.plugin.settings.apiKey)
                    .onChange(async (value) => {
                        this.plugin.settings.apiKey = value.trim();
                        await this.plugin.saveSettings();
                    });
                text.inputEl.type = 'password';
            });

        new Setting(containerEl)
            .setName('Model')
            .setDesc('DeepSeek model for commit message generation')
            .addDropdown((dropdown) => {
                for (const key of Object.keys(DEEPSEEK_MODEL_OPTIONS)) {
                    dropdown.addOption(key, DEEPSEEK_MODEL_OPTIONS[key]);
                }
                dropdown.setValue(this.plugin.settings.model);
                dropdown.onChange(async (value) => {
                    this.plugin.settings.model = value;
                    await this.plugin.saveSettings();
                });
            });
    }

    private displayOllamaSettings(containerEl: HTMLElement): void {
        const renderVersion = this.renderVersion;
        let requestVersion = 0;
        new Setting(containerEl)
            .setName('Ollama server URL')
            .setDesc('Base URL of your ollama server')
            .addText((text) => {
                text.setPlaceholder(OLLAMA_DEFAULT_URL)
                    .setValue(this.plugin.settings.ollamaUrl)
                    .onChange(async (value) => {
                        const url = normalizeBaseUrl(value) || OLLAMA_DEFAULT_URL;
                        if (url !== this.plugin.settings.ollamaUrl) {
                            requestVersion++;
                            suggestions.empty();
                            this.plugin.settings.ollamaUrl = url;
                        }
                        await this.plugin.saveSettings();
                    });
            });

        const modelSetting = new Setting(containerEl)
            .setName('Ollama model')
            .setDesc('Type a model name or choose an installed model after refreshing');
        const suggestions = modelSetting.controlEl.createEl('datalist');
        suggestions.id = `ai-commit-ollama-models-${renderVersion}`;
        modelSetting.addText((text) => {
            text.setPlaceholder(OLLAMA_DEFAULT_MODEL)
                .setValue(this.plugin.settings.ollamaModel)
                .onChange(async (value) => {
                    this.plugin.settings.ollamaModel = value.trim();
                    await this.plugin.saveSettings();
                });
            text.inputEl.setAttribute('list', suggestions.id);
        });
        modelSetting.addExtraButton((button) => {
            button.setIcon('refresh-cw')
                .setTooltip('Detect installed models')
                .onClick(async () => {
                    const version = ++requestVersion;
                    const url = this.plugin.settings.ollamaUrl;
                    const isCurrent = () => version === requestVersion && renderVersion === this.renderVersion
                        && url === this.plugin.settings.ollamaUrl && suggestions.isConnected;
                    button.setDisabled(true);
                    suggestions.empty();
                    try {
                        const models = await this.plugin.fetchOllamaModels(url);
                        if (!isCurrent()) return;
                        for (const name of models) suggestions.createEl('option', { value: name });
                        if (models.length === 0) new Notice('No models found — pull one with `ollama pull <model>`');
                    } catch (e: unknown) {
                        if (isCurrent()) new Notice(`Could not reach Ollama — ${errorMessage(e)}`);
                    } finally {
                        button.setDisabled(false);
                    }
                });
        });
    }

}

export default class AICommitPlugin extends Plugin {
    declare settings: AICommitSettings;
    private gitViews = new Map<HTMLElement, GitViewBinding>();
    private active = false;

    async onload(): Promise<void> {
        this.active = true;
        await this.loadSettings();
        this.addSettingTab(new AICommitSettingTab(this.app, this));

        this.addCommand({
            id: 'generate-commit-message',
            name: 'Generate commit message',
            callback: () => {
                void this.generateAndFill();
            },
        });

        this.registerEvent(this.app.workspace.on('layout-change', () => this.syncGitViews()));
        this.app.workspace.onLayoutReady(() => this.syncGitViews());
    }

    onunload(): void {
        this.active = false;
        for (const [el, binding] of this.gitViews) this.disposeGitView(el, binding);
        this.gitViews.clear();
    }

    private disposeGitView(el: HTMLElement, binding: GitViewBinding): void {
        binding.observer.disconnect();
        for (const textarea of binding.textareas.values()) textarea.dispose();
        binding.textareas.clear();
        el.querySelector('#ai-commit-btn')?.remove();
    }

    private syncGitViews(): void {
        if (!this.active) return;
        const containers = new Set(this.app.workspace.getLeavesOfType('git-view').map(leaf => leaf.view.containerEl));
        for (const [el, binding] of this.gitViews) {
            if (!containers.has(el)) {
                this.disposeGitView(el, binding);
                this.gitViews.delete(el);
            }
        }
        for (const el of containers) {
            let binding = this.gitViews.get(el);
            if (!binding) {
                binding = { observer: new MutationObserver(() => this.syncGitViews()), textareas: new Map() };
                // rows changes include native Clear and the reset after a commit.
                // Ignore our own style mutations to avoid an observer loop.
                binding.observer.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['rows'] });
                this.gitViews.set(el, binding);
            }
            const textareas = new Set(el.querySelectorAll<HTMLTextAreaElement>('textarea.commit-msg-input'));
            for (const [textarea, control] of binding.textareas) {
                if (!textareas.has(textarea)) {
                    control.dispose();
                    binding.textareas.delete(textarea);
                }
            }
            for (const textarea of textareas) {
                const control = binding.textareas.get(textarea) ?? bindCommitTextarea(textarea);
                binding.textareas.set(textarea, control);
                control.schedule();
            }
        }
        this.injectButton();
    }

    injectButton(this: void): void {
        const leaves = (this as unknown as AICommitPlugin).app.workspace.getLeavesOfType('git-view');
        const plugin = this as unknown as AICommitPlugin;
        const doc = window.activeDocument;
        for (const leaf of leaves) {
            const container = leaf.view.containerEl.querySelector('.nav-buttons-container');
            if (!container || container.querySelector('#ai-commit-btn')) continue;

            const btn = doc.createElement('div');
            btn.id = 'ai-commit-btn';
            btn.className = 'clickable-icon nav-action-button ai-commit-btn';
            btn.setAttribute('aria-label', 'Generate commit message');
            setIcon(btn, 'sparkles');
            btn.addEventListener('click', () => {
                void plugin.generateAndFill();
            });

            const commitBtn = container.querySelector('#commit-btn');
            if (commitBtn) {
                commitBtn.before(btn);
            } else {
                container.appendChild(btn);
            }
        }
    }

    async fetchOllamaModels(url = this.settings.ollamaUrl): Promise<string[]> {
        const baseUrl = normalizeBaseUrl(url) || OLLAMA_DEFAULT_URL;
        const response = await requestUrl({
            url: `${baseUrl}/api/tags`,
            method: 'GET',
        });

        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Ollama ${response.status}: ${response.text}`);
        }

        const data = response.json as OllamaTagsResponse;
        return (data.models ?? [])
            .map((m) => m.name ?? m.model ?? '')
            .filter((name) => name.length > 0);
    }

    async generateAndFill(): Promise<void> {
        const { provider, apiKey, model, ollamaUrl, ollamaModel, customPrompt, timeout } = this.settings;

        if (provider === 'deepseek' && !apiKey) {
            new Notice('Set DeepSeek API key in settings');
            return;
        }
        if (provider === 'ollama' && !ollamaModel.trim()) {
            new Notice('Set ollama model in settings');
            return;
        }

        const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
        if (!vaultPath) {
            new Notice('Cannot determine vault path');
            return;
        }

        let diff: string;
        try {
            const result = execSync('git diff --cached', {
                cwd: vaultPath,
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024,
            });
            diff = result.toString();
        } catch (e: unknown) {
            new Notice(`Git error — ${errorMessage(e)}`);
            return;
        }

        if (!diff.trim()) {
            new Notice('No staged changes');
            return;
        }

        const truncatedDiff = diff.length > 8000
            ? diff.substring(0, 8000) + '\n...diff truncated'
            : diff;

        const notice = new Notice('Generating...', 0);
        this.setButtonLoading(true);

        let message = '';
        let lastError: unknown;

        for (let attempt = 1; attempt <= RETRIES; attempt++) {
            try {
                if (attempt > 1) {
                    notice.setMessage(`Generating... (attempt ${attempt}/${RETRIES})`);
                }

                const systemPrompt = customPrompt
                    ? SYSTEM_PROMPT + '\n' + customPrompt
                    : SYSTEM_PROMPT;

                const messages = [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Write a commit message for:\n\n${truncatedDiff}` },
                ];

                const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                if (provider === 'deepseek') {
                    headers['Authorization'] = `Bearer ${apiKey}`;
                }

                const requestParams = {
                    url: provider === 'ollama'
                        ? `${normalizeBaseUrl(ollamaUrl) || OLLAMA_DEFAULT_URL}/api/chat`
                        : DEEPSEEK_API_URL,
                    method: 'POST' as const,
                    headers,
                    body: provider === 'ollama'
                        ? JSON.stringify({
                            model: ollamaModel,
                            messages,
                            stream: false,
                            options: { temperature: 0.3 },
                        })
                        : JSON.stringify({
                            model,
                            messages,
                            temperature: 0.3,
                            max_tokens: 500,
                        }),
                };

                const response = await Promise.race([
                    requestUrl(requestParams),
                    timeoutPromise(timeout),
                ]);

                if (response.status < 200 || response.status >= 300) {
                    throw new Error(`API ${response.status}: ${response.text}`);
                }

                const msg = provider === 'ollama'
                    ? ((response.json as OllamaChatResponse).message?.content ?? '').trim()
                    : ((response.json as DeepSeekResponse).choices?.[0]?.message?.content ?? '').trim();

                if (!msg) {
                    throw new Error('Empty response from API');
                }

                message = cleanMessage(msg);
                break;
            } catch (e: unknown) {
                lastError = e;
                if (attempt < RETRIES && !isAbortError(e)) {
                    await new Promise((r) => window.setTimeout(r, 1000 * attempt));
                }
            }
        }

        if (message) {
            const gitLeaves = this.app.workspace.getLeavesOfType('git-view');
            if (gitLeaves.length > 0) {
                const textarea = gitLeaves[0].view.containerEl.querySelector('.commit-msg-input');
                if (textarea instanceof HTMLTextAreaElement) {
                    Object.getOwnPropertyDescriptor(
                        HTMLTextAreaElement.prototype,
                        'value'
                    )!.set!.call(textarea, message);
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));

                    textarea.focus();
                }
            }

            notice.hide();
            const preview = message.length > 60 ? message.substring(0, 60) + '...' : message;
            new Notice(`Done — ${preview}`);
        } else {
            notice.hide();
            if (isAbortError(lastError)) {
                new Notice(`Request timed out (${timeout / 1000}s)`);
            } else if (provider === 'ollama') {
                new Notice(`${errorMessage(lastError)} — is Ollama running?`);
            } else {
                new Notice(errorMessage(lastError));
            }
            console.error('AI Commit error:', lastError);
        }

        this.setButtonLoading(false);
    }

    setButtonLoading(this: void, loading: boolean): void {
        const btn = window.activeDocument.querySelector('#ai-commit-btn');
        if (!(btn instanceof HTMLElement)) return;
        if (loading) {
            btn.addClass('ai-commit-loading');
        } else {
            btn.removeClass('ai-commit-loading');
        }
    }

    async loadSettings(): Promise<void> {
        const data = await this.loadData() as Partial<AICommitSettings>;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }
}
