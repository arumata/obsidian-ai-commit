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

class AICommitSettingTab extends PluginSettingTab {
    plugin: AICommitPlugin;

    constructor(app: App, plugin: AICommitPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
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
                    this.display();
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
        new Setting(containerEl)
            .setName('Ollama server URL')
            .setDesc('Base URL of your local ollama server')
            .addText((text) => {
                text
                    .setPlaceholder(OLLAMA_DEFAULT_URL)
                    .setValue(this.plugin.settings.ollamaUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.ollamaUrl = normalizeBaseUrl(value) || OLLAMA_DEFAULT_URL;
                        await this.plugin.saveSettings();
                    });
            });

        const modelSetting = new Setting(containerEl)
            .setName('Ollama model')
            .setDesc('Name of a model pulled in ollama (e.g. "llama3.1" or "qwen2.5-coder")');

        if (this.plugin.detectedOllamaModels.length > 0) {
            modelSetting.addDropdown((dropdown) => {
                for (const name of this.plugin.detectedOllamaModels) {
                    dropdown.addOption(name, name);
                }
                if (
                    this.plugin.settings.ollamaModel &&
                    !this.plugin.detectedOllamaModels.includes(this.plugin.settings.ollamaModel)
                ) {
                    dropdown.addOption(this.plugin.settings.ollamaModel, this.plugin.settings.ollamaModel);
                }
                dropdown.setValue(this.plugin.settings.ollamaModel);
                dropdown.onChange(async (value) => {
                    this.plugin.settings.ollamaModel = value;
                    await this.plugin.saveSettings();
                });
            });
        } else {
            modelSetting.addText((text) => {
                text
                    .setPlaceholder(OLLAMA_DEFAULT_MODEL)
                    .setValue(this.plugin.settings.ollamaModel)
                    .onChange(async (value) => {
                        this.plugin.settings.ollamaModel = value.trim();
                        await this.plugin.saveSettings();
                    });
            });
        }

        modelSetting.addExtraButton((button) => {
            button
                .setIcon('refresh-cw')
                .setTooltip('Detect installed models')
                .onClick(async () => {
                    button.setDisabled(true);
                    try {
                        const models = await this.plugin.fetchOllamaModels();
                        if (models.length === 0) {
                            new Notice('No models found — pull one with `ollama pull <model>`');
                        } else {
                            this.plugin.detectedOllamaModels = models;
                            if (!this.plugin.settings.ollamaModel) {
                                this.plugin.settings.ollamaModel = models[0];
                                await this.plugin.saveSettings();
                            }
                            this.display();
                        }
                    } catch (e: unknown) {
                        new Notice(`Could not reach Ollama — ${errorMessage(e)}`);
                    } finally {
                        button.setDisabled(false);
                    }
                });
        });
    }
}

export default class AICommitPlugin extends Plugin {
    declare settings: AICommitSettings;
    detectedOllamaModels: string[] = [];

    async onload(): Promise<void> {
        await this.loadSettings();
        this.addSettingTab(new AICommitSettingTab(this.app, this));

        this.addCommand({
            id: 'generate-commit-message',
            name: 'Generate commit message',
            callback: () => {
                void this.generateAndFill();
            },
        });

        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                this.injectButton();
            })
        );

        this.app.workspace.onLayoutReady(() => {
            this.injectButton();
            this.observeGitView();
        });
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

    observeGitView(): void {
        const handler = () => {
            const leaves = this.app.workspace.getLeavesOfType('git-view');
            for (const leaf of leaves) {
                const el = leaf.view.containerEl;
                if (el.dataset.aiCommitObserved) continue;
                el.dataset.aiCommitObserved = '1';
                new MutationObserver(() => {
                    this.injectButton();
                }).observe(el, { childList: true, subtree: true });
            }
        };
        this.registerEvent(this.app.workspace.on('layout-change', handler));
        handler();
    }

    async fetchOllamaModels(): Promise<string[]> {
        const baseUrl = normalizeBaseUrl(this.settings.ollamaUrl) || OLLAMA_DEFAULT_URL;
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
