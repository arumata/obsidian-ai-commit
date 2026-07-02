import { App, Plugin, PluginSettingTab, Setting, Notice, setIcon, requestUrl } from 'obsidian';
import { execSync } from 'child_process';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const RETRIES = 3;

const MODEL_OPTIONS: Record<string, string> = {
    'deepseek-v4-flash': 'DeepSeek V4 Flash',
    'deepseek-v4-pro': 'DeepSeek V4 Pro',
};

const SYSTEM_PROMPT = [
    'You are an expert at writing git commit messages.',
    'Write a short, descriptive commit message in plain language.',
    'Do NOT use Conventional Commits format (no "type:" or "type(scope):" prefixes).',
    'Write ONLY the commit message — no explanations, no markdown fences, no quotes.',
    'Output a complete sentence. Do not truncate mid-word.',
    'Focus on WHAT changed and WHY, not HOW.',
].join('\n');

export interface AICommitSettings {
    apiKey: string;
    model: string;
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

const DEFAULT_SETTINGS: AICommitSettings = {
    apiKey: '',
    model: DEFAULT_MODEL,
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

function timeoutPromise(ms: number): Promise<never> {
    return new Promise((_, reject) =>
        window.setTimeout(() => reject(new DOMException('Request timed out', 'AbortError')), ms)
    );
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
            .setName('DeepSeek API Key')
            .setDesc('API key from platform.deepseek.com/api_keys')
            .addText((text) => {
                text
                    .setPlaceholder('sk-...')
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
                for (const key of Object.keys(MODEL_OPTIONS)) {
                    dropdown.addOption(key, MODEL_OPTIONS[key]);
                }
                dropdown.setValue(this.plugin.settings.model);
                dropdown.onChange(async (value) => {
                    this.plugin.settings.model = value;
                    await this.plugin.saveSettings();
                });
            });

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
                    .setPlaceholder('e.g. Always write messages in Russian')
                    .setValue(this.plugin.settings.customPrompt)
                    .onChange(async (value) => {
                        this.plugin.settings.customPrompt = value.trim();
                        await this.plugin.saveSettings();
                    });
                text.inputEl.rows = 3;
            });
    }
}

export default class AICommitPlugin extends Plugin {
    declare settings: AICommitSettings;

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

    async generateAndFill(): Promise<void> {
        const { apiKey, model, customPrompt, timeout } = this.settings;

        if (!apiKey) {
            new Notice('AI Commit: Set DeepSeek API key in settings');
            return;
        }

        const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
        if (!vaultPath) {
            new Notice('AI Commit: Cannot determine vault path');
            return;
        }

        let diff: string;
        try {
            diff = execSync('git diff --cached', {
                cwd: vaultPath,
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024,
            }) as string;
        } catch (e: unknown) {
            const msg = isError(e) ? e.message : String(e);
            new Notice(`AI Commit: git error — ${msg}`);
            return;
        }

        if (!diff.trim()) {
            new Notice('AI Commit: No staged changes');
            return;
        }

        const truncatedDiff = diff.length > 8000
            ? diff.substring(0, 8000) + '\n...diff truncated'
            : diff;

        const notice = new Notice('AI Commit: Generating...', 0);
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

                const response = await Promise.race([
                    requestUrl({
                        url: DEEPSEEK_API_URL,
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${apiKey}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            model,
                            messages: [
                                { role: 'system', content: systemPrompt },
                                { role: 'user', content: `Write a commit message for:\n\n${truncatedDiff}` },
                            ],
                            temperature: 0.3,
                            max_tokens: 500,
                        }),
                    }),
                    timeoutPromise(timeout),
                ]);

                if (response.status < 200 || response.status >= 300) {
                    throw new Error(`API ${response.status}: ${response.text}`);
                }

                const data = response.json as DeepSeekResponse;
                const msg = (data.choices?.[0]?.message?.content ?? '').trim();

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
                    const setter = Object.getOwnPropertyDescriptor(
                        HTMLTextAreaElement.prototype,
                        'value'
                    )!.set!;
                    setter.call(textarea, message);
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                    textarea.focus();
                }
            }

            notice.hide();
            const preview = message.length > 60 ? message.substring(0, 60) + '...' : message;
            new Notice(`Done — ${preview}`);
        } else {
            notice.hide();
            const msg = isError(lastError) ? lastError.message : String(lastError ?? 'Unknown error');
            if (isAbortError(lastError)) {
                new Notice(`Request timed out (${timeout / 1000}s)`);
            } else {
                new Notice(msg);
            }
            console.error('AI Commit error:', lastError);
        }

        this.setButtonLoading(false);
    }

    setButtonLoading(this: void, loading: boolean): void {
        const plugin = this as unknown as AICommitPlugin;
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
