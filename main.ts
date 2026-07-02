import { Plugin, PluginSettingTab, Setting, Notice, setIcon } from 'obsidian';
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

class AICommitSettingTab extends PluginSettingTab {
    plugin: AICommitPlugin;

    constructor(app: any, plugin: AICommitPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'AI Commit' });

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
                    .setDynamicTooltip()
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
            name: 'Generate AI commit message',
            callback: () => this.generateAndFill(),
        });

        this.registerEvent(
            this.app.workspace.on('layout-change', () => this.injectButton())
        );

        this.app.workspace.onLayoutReady(() => {
            this.injectButton();
            this.observeGitView();
        });
    }

    injectButton(): void {
        const leaves = this.app.workspace.getLeavesOfType('git-view');
        for (const leaf of leaves) {
            const container = leaf.view.containerEl.querySelector('.nav-buttons-container');
            if (!container || container.querySelector('#ai-commit-btn')) continue;

            const btn = document.createElement('div');
            btn.id = 'ai-commit-btn';
            btn.className = 'clickable-icon nav-action-button ai-commit-btn';
            btn.setAttribute('aria-label', 'Generate AI commit message');
            setIcon(btn, 'sparkles');
            btn.addEventListener('click', () => this.generateAndFill());

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
                const el = leaf.view.containerEl as HTMLElement;
                if (el.dataset.aiCommitObserved) continue;
                el.dataset.aiCommitObserved = '1';
                new MutationObserver(() => this.injectButton())
                    .observe(el, { childList: true, subtree: true });
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

        const vaultPath = (this.app.vault.adapter as any).basePath;
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
            });
        } catch (e: any) {
            new Notice(`AI Commit: git error — ${e.message}`);
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
        let lastError: any;

        for (let attempt = 1; attempt <= RETRIES; attempt++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            try {
                if (attempt > 1) {
                    notice.setMessage(`AI Commit: Generating... (attempt ${attempt}/${RETRIES})`);
                }

                const systemPrompt = customPrompt
                    ? SYSTEM_PROMPT + '\n' + customPrompt
                    : SYSTEM_PROMPT;

                const response = await fetch(DEEPSEEK_API_URL, {
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
                    signal: controller.signal,
                });

                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`API ${response.status}: ${errText}`);
                }

                const data = await response.json();
                const msg = (data.choices?.[0]?.message?.content || '').trim();

                if (!msg) {
                    throw new Error('Empty response from API');
                }

                message = cleanMessage(msg);
                break;
            } catch (e: any) {
                lastError = e;
                if (attempt < RETRIES && e.name !== 'AbortError') {
                    await new Promise((r) => setTimeout(r, 1000 * attempt));
                }
            } finally {
                clearTimeout(timeoutId);
            }
        }

        if (message) {
            const gitLeaves = this.app.workspace.getLeavesOfType('git-view');
            if (gitLeaves.length > 0) {
                const textarea = gitLeaves[0].view.containerEl.querySelector(
                    '.commit-msg-input'
                ) as HTMLTextAreaElement | null;
                if (textarea) {
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
            new Notice(`AI Commit: Done — ${preview}`);
        } else {
            notice.hide();
            if (lastError?.name === 'AbortError') {
                new Notice(`AI Commit: Request timed out (${timeout / 1000}s)`);
            } else {
                new Notice(`AI Commit: ${lastError?.message}`);
            }
            console.error('AI Commit error:', lastError);
        }

        this.setButtonLoading(false);
    }

    setButtonLoading(loading: boolean): void {
        const btn = document.querySelector('#ai-commit-btn') as HTMLElement | null;
        if (!btn) return;
        if (loading) {
            btn.classList.add('ai-commit-loading');
            btn.style.pointerEvents = 'none';
        } else {
            btn.classList.remove('ai-commit-loading');
            btn.style.pointerEvents = '';
        }
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }
}
