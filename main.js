"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => AICommitPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var import_child_process = require("child_process");
var DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
var DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";
var OLLAMA_DEFAULT_URL = "http://localhost:11434";
var OLLAMA_DEFAULT_MODEL = "llama3.1";
var RETRIES = 3;
var DEEPSEEK_MODEL_OPTIONS = {
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro"
};
var SYSTEM_PROMPT = [
  "You are an expert at writing git commit messages.",
  "Write a short, descriptive commit message in plain language.",
  'Do NOT use Conventional Commits format (no "type:" or "type(scope):" prefixes).',
  "Write ONLY the commit message \u2014 no explanations, no markdown fences, no quotes.",
  "Output a complete sentence. Do not truncate mid-word.",
  "Focus on WHAT changed and WHY, not HOW."
].join("\n");
var DEFAULT_SETTINGS = {
  provider: "deepseek",
  apiKey: "",
  model: DEEPSEEK_DEFAULT_MODEL,
  ollamaUrl: OLLAMA_DEFAULT_URL,
  ollamaModel: OLLAMA_DEFAULT_MODEL,
  customPrompt: "",
  timeout: 3e4
};
function cleanMessage(raw) {
  return raw.replace(/^```[a-z]*\n?/im, "").replace(/\n?```$/m, "").replace(/^["']|["']$/g, "").replace(/^commit message:\s*/im, "").replace(/^\w+(\([^)]*\))?!?:\s*/i, "").trim();
}
function isError(e) {
  return e instanceof Error;
}
function isAbortError(e) {
  return isError(e) && e.name === "AbortError";
}
function errorMessage(e) {
  if (isError(e)) {
    return e.message;
  }
  if (typeof e === "string") {
    return e;
  }
  return "Unknown error";
}
function timeoutPromise(ms) {
  return new Promise(
    (_, reject) => window.setTimeout(() => reject(new DOMException("Request timed out", "AbortError")), ms)
  );
}
function normalizeBaseUrl(url) {
  return url.trim().replace(/\/+$/, "");
}
var AICommitSettingTab = class extends import_obsidian.PluginSettingTab {
  plugin;
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Provider").setDesc("AI provider used to generate commit messages").addDropdown((dropdown) => {
      dropdown.addOption("deepseek", "DeepSeek (cloud)");
      dropdown.addOption("ollama", "Ollama (local)");
      dropdown.setValue(this.plugin.settings.provider);
      dropdown.onChange(async (value) => {
        this.plugin.settings.provider = value;
        await this.plugin.saveSettings();
        this.display();
      });
    });
    if (this.plugin.settings.provider === "ollama") {
      this.displayOllamaSettings(containerEl);
    } else {
      this.displayDeepSeekSettings(containerEl);
    }
    new import_obsidian.Setting(containerEl).setName("Timeout").setDesc("API request timeout in seconds").addSlider((slider) => {
      slider.setLimits(10, 120, 5).setValue(this.plugin.settings.timeout / 1e3).onChange(async (value) => {
        this.plugin.settings.timeout = value * 1e3;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian.Setting(containerEl).setName("Custom instructions").setDesc("Appended to the system prompt (language, style, extra rules)").addTextArea((text) => {
      text.setPlaceholder("Write concise commit messages").setValue(this.plugin.settings.customPrompt).onChange(async (value) => {
        this.plugin.settings.customPrompt = value.trim();
        await this.plugin.saveSettings();
      });
      text.inputEl.rows = 3;
    });
  }
  displayDeepSeekSettings(containerEl) {
    new import_obsidian.Setting(containerEl).setName("DeepSeek API key").setDesc("DeepSeek API key").addText((text) => {
      text.setPlaceholder("Sk-\u2026").setValue(this.plugin.settings.apiKey).onChange(async (value) => {
        this.plugin.settings.apiKey = value.trim();
        await this.plugin.saveSettings();
      });
      text.inputEl.type = "password";
    });
    new import_obsidian.Setting(containerEl).setName("Model").setDesc("DeepSeek model for commit message generation").addDropdown((dropdown) => {
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
  displayOllamaSettings(containerEl) {
    new import_obsidian.Setting(containerEl).setName("Ollama server URL").setDesc("Base URL of your local ollama server").addText((text) => {
      text.setPlaceholder(OLLAMA_DEFAULT_URL).setValue(this.plugin.settings.ollamaUrl).onChange(async (value) => {
        this.plugin.settings.ollamaUrl = normalizeBaseUrl(value) || OLLAMA_DEFAULT_URL;
        await this.plugin.saveSettings();
      });
    });
    const modelSetting = new import_obsidian.Setting(containerEl).setName("Ollama model").setDesc('Name of a model pulled in ollama (e.g. "llama3.1" or "qwen2.5-coder")');
    if (this.plugin.detectedOllamaModels.length > 0) {
      modelSetting.addDropdown((dropdown) => {
        for (const name of this.plugin.detectedOllamaModels) {
          dropdown.addOption(name, name);
        }
        if (this.plugin.settings.ollamaModel && !this.plugin.detectedOllamaModels.includes(this.plugin.settings.ollamaModel)) {
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
        text.setPlaceholder(OLLAMA_DEFAULT_MODEL).setValue(this.plugin.settings.ollamaModel).onChange(async (value) => {
          this.plugin.settings.ollamaModel = value.trim();
          await this.plugin.saveSettings();
        });
      });
    }
    modelSetting.addExtraButton((button) => {
      button.setIcon("refresh-cw").setTooltip("Detect installed models").onClick(async () => {
        button.setDisabled(true);
        try {
          const models = await this.plugin.fetchOllamaModels();
          if (models.length === 0) {
            new import_obsidian.Notice("No models found \u2014 pull one with `ollama pull <model>`");
          } else {
            this.plugin.detectedOllamaModels = models;
            if (!this.plugin.settings.ollamaModel) {
              this.plugin.settings.ollamaModel = models[0];
              await this.plugin.saveSettings();
            }
            this.display();
          }
        } catch (e) {
          new import_obsidian.Notice(`Could not reach Ollama \u2014 ${errorMessage(e)}`);
        } finally {
          button.setDisabled(false);
        }
      });
    });
  }
};
var AICommitPlugin = class extends import_obsidian.Plugin {
  detectedOllamaModels = [];
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new AICommitSettingTab(this.app, this));
    this.addCommand({
      id: "generate-commit-message",
      name: "Generate commit message",
      callback: () => {
        void this.generateAndFill();
      }
    });
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.injectButton();
      })
    );
    this.app.workspace.onLayoutReady(() => {
      this.injectButton();
      this.observeGitView();
    });
  }
  injectButton() {
    const leaves = this.app.workspace.getLeavesOfType("git-view");
    const plugin = this;
    const doc = window.activeDocument;
    for (const leaf of leaves) {
      const container = leaf.view.containerEl.querySelector(".nav-buttons-container");
      if (!container || container.querySelector("#ai-commit-btn")) continue;
      const btn = doc.createElement("div");
      btn.id = "ai-commit-btn";
      btn.className = "clickable-icon nav-action-button ai-commit-btn";
      btn.setAttribute("aria-label", "Generate commit message");
      (0, import_obsidian.setIcon)(btn, "sparkles");
      btn.addEventListener("click", () => {
        void plugin.generateAndFill();
      });
      const commitBtn = container.querySelector("#commit-btn");
      if (commitBtn) {
        commitBtn.before(btn);
      } else {
        container.appendChild(btn);
      }
    }
  }
  observeGitView() {
    const handler = () => {
      const leaves = this.app.workspace.getLeavesOfType("git-view");
      for (const leaf of leaves) {
        const el = leaf.view.containerEl;
        if (el.dataset.aiCommitObserved) continue;
        el.dataset.aiCommitObserved = "1";
        new MutationObserver(() => {
          this.injectButton();
        }).observe(el, { childList: true, subtree: true });
      }
    };
    this.registerEvent(this.app.workspace.on("layout-change", handler));
    handler();
  }
  async fetchOllamaModels() {
    const baseUrl = normalizeBaseUrl(this.settings.ollamaUrl) || OLLAMA_DEFAULT_URL;
    const response = await (0, import_obsidian.requestUrl)({
      url: `${baseUrl}/api/tags`,
      method: "GET"
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Ollama ${response.status}: ${response.text}`);
    }
    const data = response.json;
    return (data.models ?? []).map((m) => m.name ?? m.model ?? "").filter((name) => name.length > 0);
  }
  async generateAndFill() {
    const { provider, apiKey, model, ollamaUrl, ollamaModel, customPrompt, timeout } = this.settings;
    if (provider === "deepseek" && !apiKey) {
      new import_obsidian.Notice("Set DeepSeek API key in settings");
      return;
    }
    if (provider === "ollama" && !ollamaModel.trim()) {
      new import_obsidian.Notice("Set ollama model in settings");
      return;
    }
    const vaultPath = this.app.vault.adapter.basePath;
    if (!vaultPath) {
      new import_obsidian.Notice("Cannot determine vault path");
      return;
    }
    let diff;
    try {
      const result = (0, import_child_process.execSync)("git diff --cached", {
        cwd: vaultPath,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024
      });
      diff = result.toString();
    } catch (e) {
      new import_obsidian.Notice(`Git error \u2014 ${errorMessage(e)}`);
      return;
    }
    if (!diff.trim()) {
      new import_obsidian.Notice("No staged changes");
      return;
    }
    const truncatedDiff = diff.length > 8e3 ? diff.substring(0, 8e3) + "\n...diff truncated" : diff;
    const notice = new import_obsidian.Notice("Generating...", 0);
    this.setButtonLoading(true);
    let message = "";
    let lastError;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        if (attempt > 1) {
          notice.setMessage(`Generating... (attempt ${attempt}/${RETRIES})`);
        }
        const systemPrompt = customPrompt ? SYSTEM_PROMPT + "\n" + customPrompt : SYSTEM_PROMPT;
        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Write a commit message for:

${truncatedDiff}` }
        ];
        const headers = { "Content-Type": "application/json" };
        if (provider === "deepseek") {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }
        const requestParams = {
          url: provider === "ollama" ? `${normalizeBaseUrl(ollamaUrl) || OLLAMA_DEFAULT_URL}/api/chat` : DEEPSEEK_API_URL,
          method: "POST",
          headers,
          body: provider === "ollama" ? JSON.stringify({
            model: ollamaModel,
            messages,
            stream: false,
            options: { temperature: 0.3 }
          }) : JSON.stringify({
            model,
            messages,
            temperature: 0.3,
            max_tokens: 500
          })
        };
        const response = await Promise.race([
          (0, import_obsidian.requestUrl)(requestParams),
          timeoutPromise(timeout)
        ]);
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`API ${response.status}: ${response.text}`);
        }
        const msg = provider === "ollama" ? (response.json.message?.content ?? "").trim() : (response.json.choices?.[0]?.message?.content ?? "").trim();
        if (!msg) {
          throw new Error("Empty response from API");
        }
        message = cleanMessage(msg);
        break;
      } catch (e) {
        lastError = e;
        if (attempt < RETRIES && !isAbortError(e)) {
          await new Promise((r) => window.setTimeout(r, 1e3 * attempt));
        }
      }
    }
    if (message) {
      const gitLeaves = this.app.workspace.getLeavesOfType("git-view");
      if (gitLeaves.length > 0) {
        const textarea = gitLeaves[0].view.containerEl.querySelector(".commit-msg-input");
        if (textarea instanceof HTMLTextAreaElement) {
          Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value"
          ).set.call(textarea, message);
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          textarea.focus();
        }
      }
      notice.hide();
      const preview = message.length > 60 ? message.substring(0, 60) + "..." : message;
      new import_obsidian.Notice(`Done \u2014 ${preview}`);
    } else {
      notice.hide();
      if (isAbortError(lastError)) {
        new import_obsidian.Notice(`Request timed out (${timeout / 1e3}s)`);
      } else if (provider === "ollama") {
        new import_obsidian.Notice(`${errorMessage(lastError)} \u2014 is Ollama running?`);
      } else {
        new import_obsidian.Notice(errorMessage(lastError));
      }
      console.error("AI Commit error:", lastError);
    }
    this.setButtonLoading(false);
  }
  setButtonLoading(loading) {
    const btn = window.activeDocument.querySelector("#ai-commit-btn");
    if (!(btn instanceof HTMLElement)) return;
    if (loading) {
      btn.addClass("ai-commit-loading");
    } else {
      btn.removeClass("ai-commit-loading");
    }
  }
  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsibWFpbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgQXBwLCBQbHVnaW4sIFBsdWdpblNldHRpbmdUYWIsIFNldHRpbmcsIE5vdGljZSwgc2V0SWNvbiwgcmVxdWVzdFVybCB9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCB7IGV4ZWNTeW5jIH0gZnJvbSAnY2hpbGRfcHJvY2Vzcyc7XG5cbmNvbnN0IERFRVBTRUVLX0FQSV9VUkwgPSAnaHR0cHM6Ly9hcGkuZGVlcHNlZWsuY29tL2NoYXQvY29tcGxldGlvbnMnO1xuY29uc3QgREVFUFNFRUtfREVGQVVMVF9NT0RFTCA9ICdkZWVwc2Vlay12NC1mbGFzaCc7XG5jb25zdCBPTExBTUFfREVGQVVMVF9VUkwgPSAnaHR0cDovL2xvY2FsaG9zdDoxMTQzNCc7XG5jb25zdCBPTExBTUFfREVGQVVMVF9NT0RFTCA9ICdsbGFtYTMuMSc7XG5jb25zdCBSRVRSSUVTID0gMztcblxuY29uc3QgREVFUFNFRUtfTU9ERUxfT1BUSU9OUzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICAnZGVlcHNlZWstdjQtZmxhc2gnOiAnRGVlcFNlZWsgVjQgRmxhc2gnLFxuICAgICdkZWVwc2Vlay12NC1wcm8nOiAnRGVlcFNlZWsgVjQgUHJvJyxcbn07XG5cbnR5cGUgUHJvdmlkZXIgPSAnZGVlcHNlZWsnIHwgJ29sbGFtYSc7XG5cbmNvbnN0IFNZU1RFTV9QUk9NUFQgPSBbXG4gICAgJ1lvdSBhcmUgYW4gZXhwZXJ0IGF0IHdyaXRpbmcgZ2l0IGNvbW1pdCBtZXNzYWdlcy4nLFxuICAgICdXcml0ZSBhIHNob3J0LCBkZXNjcmlwdGl2ZSBjb21taXQgbWVzc2FnZSBpbiBwbGFpbiBsYW5ndWFnZS4nLFxuICAgICdEbyBOT1QgdXNlIENvbnZlbnRpb25hbCBDb21taXRzIGZvcm1hdCAobm8gXCJ0eXBlOlwiIG9yIFwidHlwZShzY29wZSk6XCIgcHJlZml4ZXMpLicsXG4gICAgJ1dyaXRlIE9OTFkgdGhlIGNvbW1pdCBtZXNzYWdlIFx1MjAxNCBubyBleHBsYW5hdGlvbnMsIG5vIG1hcmtkb3duIGZlbmNlcywgbm8gcXVvdGVzLicsXG4gICAgJ091dHB1dCBhIGNvbXBsZXRlIHNlbnRlbmNlLiBEbyBub3QgdHJ1bmNhdGUgbWlkLXdvcmQuJyxcbiAgICAnRm9jdXMgb24gV0hBVCBjaGFuZ2VkIGFuZCBXSFksIG5vdCBIT1cuJyxcbl0uam9pbignXFxuJyk7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQUlDb21taXRTZXR0aW5ncyB7XG4gICAgcHJvdmlkZXI6IFByb3ZpZGVyO1xuICAgIGFwaUtleTogc3RyaW5nO1xuICAgIG1vZGVsOiBzdHJpbmc7XG4gICAgb2xsYW1hVXJsOiBzdHJpbmc7XG4gICAgb2xsYW1hTW9kZWw6IHN0cmluZztcbiAgICBjdXN0b21Qcm9tcHQ6IHN0cmluZztcbiAgICB0aW1lb3V0OiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBEZWVwU2Vla1Jlc3BvbnNlIHtcbiAgICBjaG9pY2VzPzogQXJyYXk8e1xuICAgICAgICBtZXNzYWdlPzoge1xuICAgICAgICAgICAgY29udGVudD86IHN0cmluZztcbiAgICAgICAgfTtcbiAgICB9Pjtcbn1cblxuaW50ZXJmYWNlIE9sbGFtYUNoYXRSZXNwb25zZSB7XG4gICAgbWVzc2FnZT86IHtcbiAgICAgICAgY29udGVudD86IHN0cmluZztcbiAgICB9O1xufVxuXG5pbnRlcmZhY2UgT2xsYW1hVGFnc1Jlc3BvbnNlIHtcbiAgICBtb2RlbHM/OiBBcnJheTx7XG4gICAgICAgIG5hbWU/OiBzdHJpbmc7XG4gICAgICAgIG1vZGVsPzogc3RyaW5nO1xuICAgIH0+O1xufVxuXG5jb25zdCBERUZBVUxUX1NFVFRJTkdTOiBBSUNvbW1pdFNldHRpbmdzID0ge1xuICAgIHByb3ZpZGVyOiAnZGVlcHNlZWsnLFxuICAgIGFwaUtleTogJycsXG4gICAgbW9kZWw6IERFRVBTRUVLX0RFRkFVTFRfTU9ERUwsXG4gICAgb2xsYW1hVXJsOiBPTExBTUFfREVGQVVMVF9VUkwsXG4gICAgb2xsYW1hTW9kZWw6IE9MTEFNQV9ERUZBVUxUX01PREVMLFxuICAgIGN1c3RvbVByb21wdDogJycsXG4gICAgdGltZW91dDogMzAwMDAsXG59O1xuXG5mdW5jdGlvbiBjbGVhbk1lc3NhZ2UocmF3OiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIHJldHVybiByYXdcbiAgICAgICAgLnJlcGxhY2UoL15gYGBbYS16XSpcXG4/L2ltLCAnJylcbiAgICAgICAgLnJlcGxhY2UoL1xcbj9gYGAkL20sICcnKVxuICAgICAgICAucmVwbGFjZSgvXltcIiddfFtcIiddJC9nLCAnJylcbiAgICAgICAgLnJlcGxhY2UoL15jb21taXQgbWVzc2FnZTpcXHMqL2ltLCAnJylcbiAgICAgICAgLnJlcGxhY2UoL15cXHcrKFxcKFteKV0qXFwpKT8hPzpcXHMqL2ksICcnKVxuICAgICAgICAudHJpbSgpO1xufVxuXG5mdW5jdGlvbiBpc0Vycm9yKGU6IHVua25vd24pOiBlIGlzIEVycm9yIHtcbiAgICByZXR1cm4gZSBpbnN0YW5jZW9mIEVycm9yO1xufVxuXG5mdW5jdGlvbiBpc0Fib3J0RXJyb3IoZTogdW5rbm93bik6IGJvb2xlYW4ge1xuICAgIHJldHVybiBpc0Vycm9yKGUpICYmIGUubmFtZSA9PT0gJ0Fib3J0RXJyb3InO1xufVxuXG5mdW5jdGlvbiBlcnJvck1lc3NhZ2UoZTogdW5rbm93bik6IHN0cmluZyB7XG4gICAgaWYgKGlzRXJyb3IoZSkpIHtcbiAgICAgICAgcmV0dXJuIGUubWVzc2FnZTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBlID09PSAnc3RyaW5nJykge1xuICAgICAgICByZXR1cm4gZTtcbiAgICB9XG4gICAgcmV0dXJuICdVbmtub3duIGVycm9yJztcbn1cblxuZnVuY3Rpb24gdGltZW91dFByb21pc2UobXM6IG51bWJlcik6IFByb21pc2U8bmV2ZXI+IHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKF8sIHJlamVjdCkgPT5cbiAgICAgICAgd2luZG93LnNldFRpbWVvdXQoKCkgPT4gcmVqZWN0KG5ldyBET01FeGNlcHRpb24oJ1JlcXVlc3QgdGltZWQgb3V0JywgJ0Fib3J0RXJyb3InKSksIG1zKVxuICAgICk7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUJhc2VVcmwodXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIHJldHVybiB1cmwudHJpbSgpLnJlcGxhY2UoL1xcLyskLywgJycpO1xufVxuXG5jbGFzcyBBSUNvbW1pdFNldHRpbmdUYWIgZXh0ZW5kcyBQbHVnaW5TZXR0aW5nVGFiIHtcbiAgICBwbHVnaW46IEFJQ29tbWl0UGx1Z2luO1xuXG4gICAgY29uc3RydWN0b3IoYXBwOiBBcHAsIHBsdWdpbjogQUlDb21taXRQbHVnaW4pIHtcbiAgICAgICAgc3VwZXIoYXBwLCBwbHVnaW4pO1xuICAgICAgICB0aGlzLnBsdWdpbiA9IHBsdWdpbjtcbiAgICB9XG5cbiAgICBkaXNwbGF5KCk6IHZvaWQge1xuICAgICAgICBjb25zdCB7IGNvbnRhaW5lckVsIH0gPSB0aGlzO1xuICAgICAgICBjb250YWluZXJFbC5lbXB0eSgpO1xuXG4gICAgICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgICAgICAgLnNldE5hbWUoJ1Byb3ZpZGVyJylcbiAgICAgICAgICAgIC5zZXREZXNjKCdBSSBwcm92aWRlciB1c2VkIHRvIGdlbmVyYXRlIGNvbW1pdCBtZXNzYWdlcycpXG4gICAgICAgICAgICAuYWRkRHJvcGRvd24oKGRyb3Bkb3duKSA9PiB7XG4gICAgICAgICAgICAgICAgZHJvcGRvd24uYWRkT3B0aW9uKCdkZWVwc2VlaycsICdEZWVwU2VlayAoY2xvdWQpJyk7XG4gICAgICAgICAgICAgICAgZHJvcGRvd24uYWRkT3B0aW9uKCdvbGxhbWEnLCAnT2xsYW1hIChsb2NhbCknKTtcbiAgICAgICAgICAgICAgICBkcm9wZG93bi5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5wcm92aWRlcik7XG4gICAgICAgICAgICAgICAgZHJvcGRvd24ub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnByb3ZpZGVyID0gdmFsdWUgYXMgUHJvdmlkZXI7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmRpc3BsYXkoKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgIGlmICh0aGlzLnBsdWdpbi5zZXR0aW5ncy5wcm92aWRlciA9PT0gJ29sbGFtYScpIHtcbiAgICAgICAgICAgIHRoaXMuZGlzcGxheU9sbGFtYVNldHRpbmdzKGNvbnRhaW5lckVsKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuZGlzcGxheURlZXBTZWVrU2V0dGluZ3MoY29udGFpbmVyRWwpO1xuICAgICAgICB9XG5cbiAgICAgICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAgICAgICAuc2V0TmFtZSgnVGltZW91dCcpXG4gICAgICAgICAgICAuc2V0RGVzYygnQVBJIHJlcXVlc3QgdGltZW91dCBpbiBzZWNvbmRzJylcbiAgICAgICAgICAgIC5hZGRTbGlkZXIoKHNsaWRlcikgPT4ge1xuICAgICAgICAgICAgICAgIHNsaWRlclxuICAgICAgICAgICAgICAgICAgICAuc2V0TGltaXRzKDEwLCAxMjAsIDUpXG4gICAgICAgICAgICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy50aW1lb3V0IC8gMTAwMClcbiAgICAgICAgICAgICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MudGltZW91dCA9IHZhbHVlICogMTAwMDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgICAgICAgLnNldE5hbWUoJ0N1c3RvbSBpbnN0cnVjdGlvbnMnKVxuICAgICAgICAgICAgLnNldERlc2MoJ0FwcGVuZGVkIHRvIHRoZSBzeXN0ZW0gcHJvbXB0IChsYW5ndWFnZSwgc3R5bGUsIGV4dHJhIHJ1bGVzKScpXG4gICAgICAgICAgICAuYWRkVGV4dEFyZWEoKHRleHQpID0+IHtcbiAgICAgICAgICAgICAgICB0ZXh0XG4gICAgICAgICAgICAgICAgICAgIC5zZXRQbGFjZWhvbGRlcignV3JpdGUgY29uY2lzZSBjb21taXQgbWVzc2FnZXMnKVxuICAgICAgICAgICAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuY3VzdG9tUHJvbXB0KVxuICAgICAgICAgICAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5jdXN0b21Qcm9tcHQgPSB2YWx1ZS50cmltKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgdGV4dC5pbnB1dEVsLnJvd3MgPSAzO1xuICAgICAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgcHJpdmF0ZSBkaXNwbGF5RGVlcFNlZWtTZXR0aW5ncyhjb250YWluZXJFbDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgICAgICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAgICAgICAuc2V0TmFtZSgnRGVlcFNlZWsgQVBJIGtleScpXG4gICAgICAgICAgICAuc2V0RGVzYygnRGVlcFNlZWsgQVBJIGtleScpXG4gICAgICAgICAgICAuYWRkVGV4dCgodGV4dCkgPT4ge1xuICAgICAgICAgICAgICAgIHRleHRcbiAgICAgICAgICAgICAgICAgICAgLnNldFBsYWNlaG9sZGVyKCdTay1cdTIwMjYnKVxuICAgICAgICAgICAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuYXBpS2V5KVxuICAgICAgICAgICAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5hcGlLZXkgPSB2YWx1ZS50cmltKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgdGV4dC5pbnB1dEVsLnR5cGUgPSAncGFzc3dvcmQnO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAgICAgICAuc2V0TmFtZSgnTW9kZWwnKVxuICAgICAgICAgICAgLnNldERlc2MoJ0RlZXBTZWVrIG1vZGVsIGZvciBjb21taXQgbWVzc2FnZSBnZW5lcmF0aW9uJylcbiAgICAgICAgICAgIC5hZGREcm9wZG93bigoZHJvcGRvd24pID0+IHtcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhERUVQU0VFS19NT0RFTF9PUFRJT05TKSkge1xuICAgICAgICAgICAgICAgICAgICBkcm9wZG93bi5hZGRPcHRpb24oa2V5LCBERUVQU0VFS19NT0RFTF9PUFRJT05TW2tleV0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBkcm9wZG93bi5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5tb2RlbCk7XG4gICAgICAgICAgICAgICAgZHJvcGRvd24ub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLm1vZGVsID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgcHJpdmF0ZSBkaXNwbGF5T2xsYW1hU2V0dGluZ3MoY29udGFpbmVyRWw6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gICAgICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgICAgICAgLnNldE5hbWUoJ09sbGFtYSBzZXJ2ZXIgVVJMJylcbiAgICAgICAgICAgIC5zZXREZXNjKCdCYXNlIFVSTCBvZiB5b3VyIGxvY2FsIG9sbGFtYSBzZXJ2ZXInKVxuICAgICAgICAgICAgLmFkZFRleHQoKHRleHQpID0+IHtcbiAgICAgICAgICAgICAgICB0ZXh0XG4gICAgICAgICAgICAgICAgICAgIC5zZXRQbGFjZWhvbGRlcihPTExBTUFfREVGQVVMVF9VUkwpXG4gICAgICAgICAgICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5vbGxhbWFVcmwpXG4gICAgICAgICAgICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLm9sbGFtYVVybCA9IG5vcm1hbGl6ZUJhc2VVcmwodmFsdWUpIHx8IE9MTEFNQV9ERUZBVUxUX1VSTDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IG1vZGVsU2V0dGluZyA9IG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgICAgICAgLnNldE5hbWUoJ09sbGFtYSBtb2RlbCcpXG4gICAgICAgICAgICAuc2V0RGVzYygnTmFtZSBvZiBhIG1vZGVsIHB1bGxlZCBpbiBvbGxhbWEgKGUuZy4gXCJsbGFtYTMuMVwiIG9yIFwicXdlbjIuNS1jb2RlclwiKScpO1xuXG4gICAgICAgIGlmICh0aGlzLnBsdWdpbi5kZXRlY3RlZE9sbGFtYU1vZGVscy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBtb2RlbFNldHRpbmcuYWRkRHJvcGRvd24oKGRyb3Bkb3duKSA9PiB7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBuYW1lIG9mIHRoaXMucGx1Z2luLmRldGVjdGVkT2xsYW1hTW9kZWxzKSB7XG4gICAgICAgICAgICAgICAgICAgIGRyb3Bkb3duLmFkZE9wdGlvbihuYW1lLCBuYW1lKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5vbGxhbWFNb2RlbCAmJlxuICAgICAgICAgICAgICAgICAgICAhdGhpcy5wbHVnaW4uZGV0ZWN0ZWRPbGxhbWFNb2RlbHMuaW5jbHVkZXModGhpcy5wbHVnaW4uc2V0dGluZ3Mub2xsYW1hTW9kZWwpXG4gICAgICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgICAgIGRyb3Bkb3duLmFkZE9wdGlvbih0aGlzLnBsdWdpbi5zZXR0aW5ncy5vbGxhbWFNb2RlbCwgdGhpcy5wbHVnaW4uc2V0dGluZ3Mub2xsYW1hTW9kZWwpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBkcm9wZG93bi5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5vbGxhbWFNb2RlbCk7XG4gICAgICAgICAgICAgICAgZHJvcGRvd24ub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLm9sbGFtYU1vZGVsID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBtb2RlbFNldHRpbmcuYWRkVGV4dCgodGV4dCkgPT4ge1xuICAgICAgICAgICAgICAgIHRleHRcbiAgICAgICAgICAgICAgICAgICAgLnNldFBsYWNlaG9sZGVyKE9MTEFNQV9ERUZBVUxUX01PREVMKVxuICAgICAgICAgICAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3Mub2xsYW1hTW9kZWwpXG4gICAgICAgICAgICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLm9sbGFtYU1vZGVsID0gdmFsdWUudHJpbSgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBtb2RlbFNldHRpbmcuYWRkRXh0cmFCdXR0b24oKGJ1dHRvbikgPT4ge1xuICAgICAgICAgICAgYnV0dG9uXG4gICAgICAgICAgICAgICAgLnNldEljb24oJ3JlZnJlc2gtY3cnKVxuICAgICAgICAgICAgICAgIC5zZXRUb29sdGlwKCdEZXRlY3QgaW5zdGFsbGVkIG1vZGVscycpXG4gICAgICAgICAgICAgICAgLm9uQ2xpY2soYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBidXR0b24uc2V0RGlzYWJsZWQodHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBtb2RlbHMgPSBhd2FpdCB0aGlzLnBsdWdpbi5mZXRjaE9sbGFtYU1vZGVscygpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKG1vZGVscy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBuZXcgTm90aWNlKCdObyBtb2RlbHMgZm91bmQgXHUyMDE0IHB1bGwgb25lIHdpdGggYG9sbGFtYSBwdWxsIDxtb2RlbD5gJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLmRldGVjdGVkT2xsYW1hTW9kZWxzID0gbW9kZWxzO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghdGhpcy5wbHVnaW4uc2V0dGluZ3Mub2xsYW1hTW9kZWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3Mub2xsYW1hTW9kZWwgPSBtb2RlbHNbMF07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmRpc3BsYXkoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZTogdW5rbm93bikge1xuICAgICAgICAgICAgICAgICAgICAgICAgbmV3IE5vdGljZShgQ291bGQgbm90IHJlYWNoIE9sbGFtYSBcdTIwMTQgJHtlcnJvck1lc3NhZ2UoZSl9YCk7XG4gICAgICAgICAgICAgICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBidXR0b24uc2V0RGlzYWJsZWQoZmFsc2UpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgQUlDb21taXRQbHVnaW4gZXh0ZW5kcyBQbHVnaW4ge1xuICAgIGRlY2xhcmUgc2V0dGluZ3M6IEFJQ29tbWl0U2V0dGluZ3M7XG4gICAgZGV0ZWN0ZWRPbGxhbWFNb2RlbHM6IHN0cmluZ1tdID0gW107XG5cbiAgICBhc3luYyBvbmxvYWQoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgICAgIGF3YWl0IHRoaXMubG9hZFNldHRpbmdzKCk7XG4gICAgICAgIHRoaXMuYWRkU2V0dGluZ1RhYihuZXcgQUlDb21taXRTZXR0aW5nVGFiKHRoaXMuYXBwLCB0aGlzKSk7XG5cbiAgICAgICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgICAgICAgIGlkOiAnZ2VuZXJhdGUtY29tbWl0LW1lc3NhZ2UnLFxuICAgICAgICAgICAgbmFtZTogJ0dlbmVyYXRlIGNvbW1pdCBtZXNzYWdlJyxcbiAgICAgICAgICAgIGNhbGxiYWNrOiAoKSA9PiB7XG4gICAgICAgICAgICAgICAgdm9pZCB0aGlzLmdlbmVyYXRlQW5kRmlsbCgpO1xuICAgICAgICAgICAgfSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KFxuICAgICAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLm9uKCdsYXlvdXQtY2hhbmdlJywgKCkgPT4ge1xuICAgICAgICAgICAgICAgIHRoaXMuaW5qZWN0QnV0dG9uKCk7XG4gICAgICAgICAgICB9KVxuICAgICAgICApO1xuXG4gICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5vbkxheW91dFJlYWR5KCgpID0+IHtcbiAgICAgICAgICAgIHRoaXMuaW5qZWN0QnV0dG9uKCk7XG4gICAgICAgICAgICB0aGlzLm9ic2VydmVHaXRWaWV3KCk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGluamVjdEJ1dHRvbih0aGlzOiB2b2lkKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IGxlYXZlcyA9ICh0aGlzIGFzIHVua25vd24gYXMgQUlDb21taXRQbHVnaW4pLmFwcC53b3Jrc3BhY2UuZ2V0TGVhdmVzT2ZUeXBlKCdnaXQtdmlldycpO1xuICAgICAgICBjb25zdCBwbHVnaW4gPSB0aGlzIGFzIHVua25vd24gYXMgQUlDb21taXRQbHVnaW47XG4gICAgICAgIGNvbnN0IGRvYyA9IHdpbmRvdy5hY3RpdmVEb2N1bWVudDtcbiAgICAgICAgZm9yIChjb25zdCBsZWFmIG9mIGxlYXZlcykge1xuICAgICAgICAgICAgY29uc3QgY29udGFpbmVyID0gbGVhZi52aWV3LmNvbnRhaW5lckVsLnF1ZXJ5U2VsZWN0b3IoJy5uYXYtYnV0dG9ucy1jb250YWluZXInKTtcbiAgICAgICAgICAgIGlmICghY29udGFpbmVyIHx8IGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yKCcjYWktY29tbWl0LWJ0bicpKSBjb250aW51ZTtcblxuICAgICAgICAgICAgY29uc3QgYnRuID0gZG9jLmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICAgICAgYnRuLmlkID0gJ2FpLWNvbW1pdC1idG4nO1xuICAgICAgICAgICAgYnRuLmNsYXNzTmFtZSA9ICdjbGlja2FibGUtaWNvbiBuYXYtYWN0aW9uLWJ1dHRvbiBhaS1jb21taXQtYnRuJztcbiAgICAgICAgICAgIGJ0bi5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCAnR2VuZXJhdGUgY29tbWl0IG1lc3NhZ2UnKTtcbiAgICAgICAgICAgIHNldEljb24oYnRuLCAnc3BhcmtsZXMnKTtcbiAgICAgICAgICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgICAgICB2b2lkIHBsdWdpbi5nZW5lcmF0ZUFuZEZpbGwoKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBjb25zdCBjb21taXRCdG4gPSBjb250YWluZXIucXVlcnlTZWxlY3RvcignI2NvbW1pdC1idG4nKTtcbiAgICAgICAgICAgIGlmIChjb21taXRCdG4pIHtcbiAgICAgICAgICAgICAgICBjb21taXRCdG4uYmVmb3JlKGJ0bik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnRhaW5lci5hcHBlbmRDaGlsZChidG4pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgb2JzZXJ2ZUdpdFZpZXcoKTogdm9pZCB7XG4gICAgICAgIGNvbnN0IGhhbmRsZXIgPSAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBsZWF2ZXMgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0TGVhdmVzT2ZUeXBlKCdnaXQtdmlldycpO1xuICAgICAgICAgICAgZm9yIChjb25zdCBsZWFmIG9mIGxlYXZlcykge1xuICAgICAgICAgICAgICAgIGNvbnN0IGVsID0gbGVhZi52aWV3LmNvbnRhaW5lckVsO1xuICAgICAgICAgICAgICAgIGlmIChlbC5kYXRhc2V0LmFpQ29tbWl0T2JzZXJ2ZWQpIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIGVsLmRhdGFzZXQuYWlDb21taXRPYnNlcnZlZCA9ICcxJztcbiAgICAgICAgICAgICAgICBuZXcgTXV0YXRpb25PYnNlcnZlcigoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuaW5qZWN0QnV0dG9uKCk7XG4gICAgICAgICAgICAgICAgfSkub2JzZXJ2ZShlbCwgeyBjaGlsZExpc3Q6IHRydWUsIHN1YnRyZWU6IHRydWUgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudCh0aGlzLmFwcC53b3Jrc3BhY2Uub24oJ2xheW91dC1jaGFuZ2UnLCBoYW5kbGVyKSk7XG4gICAgICAgIGhhbmRsZXIoKTtcbiAgICB9XG5cbiAgICBhc3luYyBmZXRjaE9sbGFtYU1vZGVscygpOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gICAgICAgIGNvbnN0IGJhc2VVcmwgPSBub3JtYWxpemVCYXNlVXJsKHRoaXMuc2V0dGluZ3Mub2xsYW1hVXJsKSB8fCBPTExBTUFfREVGQVVMVF9VUkw7XG4gICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmVxdWVzdFVybCh7XG4gICAgICAgICAgICB1cmw6IGAke2Jhc2VVcmx9L2FwaS90YWdzYCxcbiAgICAgICAgICAgIG1ldGhvZDogJ0dFVCcsXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmIChyZXNwb25zZS5zdGF0dXMgPCAyMDAgfHwgcmVzcG9uc2Uuc3RhdHVzID49IDMwMCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBPbGxhbWEgJHtyZXNwb25zZS5zdGF0dXN9OiAke3Jlc3BvbnNlLnRleHR9YCk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBkYXRhID0gcmVzcG9uc2UuanNvbiBhcyBPbGxhbWFUYWdzUmVzcG9uc2U7XG4gICAgICAgIHJldHVybiAoZGF0YS5tb2RlbHMgPz8gW10pXG4gICAgICAgICAgICAubWFwKChtKSA9PiBtLm5hbWUgPz8gbS5tb2RlbCA/PyAnJylcbiAgICAgICAgICAgIC5maWx0ZXIoKG5hbWUpID0+IG5hbWUubGVuZ3RoID4gMCk7XG4gICAgfVxuXG4gICAgYXN5bmMgZ2VuZXJhdGVBbmRGaWxsKCk6IFByb21pc2U8dm9pZD4ge1xuICAgICAgICBjb25zdCB7IHByb3ZpZGVyLCBhcGlLZXksIG1vZGVsLCBvbGxhbWFVcmwsIG9sbGFtYU1vZGVsLCBjdXN0b21Qcm9tcHQsIHRpbWVvdXQgfSA9IHRoaXMuc2V0dGluZ3M7XG5cbiAgICAgICAgaWYgKHByb3ZpZGVyID09PSAnZGVlcHNlZWsnICYmICFhcGlLZXkpIHtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoJ1NldCBEZWVwU2VlayBBUEkga2V5IGluIHNldHRpbmdzJyk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHByb3ZpZGVyID09PSAnb2xsYW1hJyAmJiAhb2xsYW1hTW9kZWwudHJpbSgpKSB7XG4gICAgICAgICAgICBuZXcgTm90aWNlKCdTZXQgb2xsYW1hIG1vZGVsIGluIHNldHRpbmdzJyk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB2YXVsdFBhdGggPSAodGhpcy5hcHAudmF1bHQuYWRhcHRlciBhcyB7IGJhc2VQYXRoPzogc3RyaW5nIH0pLmJhc2VQYXRoO1xuICAgICAgICBpZiAoIXZhdWx0UGF0aCkge1xuICAgICAgICAgICAgbmV3IE5vdGljZSgnQ2Fubm90IGRldGVybWluZSB2YXVsdCBwYXRoJyk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZGlmZjogc3RyaW5nO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gZXhlY1N5bmMoJ2dpdCBkaWZmIC0tY2FjaGVkJywge1xuICAgICAgICAgICAgICAgIGN3ZDogdmF1bHRQYXRoLFxuICAgICAgICAgICAgICAgIGVuY29kaW5nOiAndXRmLTgnLFxuICAgICAgICAgICAgICAgIG1heEJ1ZmZlcjogMTAgKiAxMDI0ICogMTAyNCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgZGlmZiA9IHJlc3VsdC50b1N0cmluZygpO1xuICAgICAgICB9IGNhdGNoIChlOiB1bmtub3duKSB7XG4gICAgICAgICAgICBuZXcgTm90aWNlKGBHaXQgZXJyb3IgXHUyMDE0ICR7ZXJyb3JNZXNzYWdlKGUpfWApO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFkaWZmLnRyaW0oKSkge1xuICAgICAgICAgICAgbmV3IE5vdGljZSgnTm8gc3RhZ2VkIGNoYW5nZXMnKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHRydW5jYXRlZERpZmYgPSBkaWZmLmxlbmd0aCA+IDgwMDBcbiAgICAgICAgICAgID8gZGlmZi5zdWJzdHJpbmcoMCwgODAwMCkgKyAnXFxuLi4uZGlmZiB0cnVuY2F0ZWQnXG4gICAgICAgICAgICA6IGRpZmY7XG5cbiAgICAgICAgY29uc3Qgbm90aWNlID0gbmV3IE5vdGljZSgnR2VuZXJhdGluZy4uLicsIDApO1xuICAgICAgICB0aGlzLnNldEJ1dHRvbkxvYWRpbmcodHJ1ZSk7XG5cbiAgICAgICAgbGV0IG1lc3NhZ2UgPSAnJztcbiAgICAgICAgbGV0IGxhc3RFcnJvcjogdW5rbm93bjtcblxuICAgICAgICBmb3IgKGxldCBhdHRlbXB0ID0gMTsgYXR0ZW1wdCA8PSBSRVRSSUVTOyBhdHRlbXB0KyspIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgaWYgKGF0dGVtcHQgPiAxKSB7XG4gICAgICAgICAgICAgICAgICAgIG5vdGljZS5zZXRNZXNzYWdlKGBHZW5lcmF0aW5nLi4uIChhdHRlbXB0ICR7YXR0ZW1wdH0vJHtSRVRSSUVTfSlgKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBzeXN0ZW1Qcm9tcHQgPSBjdXN0b21Qcm9tcHRcbiAgICAgICAgICAgICAgICAgICAgPyBTWVNURU1fUFJPTVBUICsgJ1xcbicgKyBjdXN0b21Qcm9tcHRcbiAgICAgICAgICAgICAgICAgICAgOiBTWVNURU1fUFJPTVBUO1xuXG4gICAgICAgICAgICAgICAgY29uc3QgbWVzc2FnZXMgPSBbXG4gICAgICAgICAgICAgICAgICAgIHsgcm9sZTogJ3N5c3RlbScsIGNvbnRlbnQ6IHN5c3RlbVByb21wdCB9LFxuICAgICAgICAgICAgICAgICAgICB7IHJvbGU6ICd1c2VyJywgY29udGVudDogYFdyaXRlIGEgY29tbWl0IG1lc3NhZ2UgZm9yOlxcblxcbiR7dHJ1bmNhdGVkRGlmZn1gIH0sXG4gICAgICAgICAgICAgICAgXTtcblxuICAgICAgICAgICAgICAgIGNvbnN0IGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfTtcbiAgICAgICAgICAgICAgICBpZiAocHJvdmlkZXIgPT09ICdkZWVwc2VlaycpIHtcbiAgICAgICAgICAgICAgICAgICAgaGVhZGVyc1snQXV0aG9yaXphdGlvbiddID0gYEJlYXJlciAke2FwaUtleX1gO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IHJlcXVlc3RQYXJhbXMgPSB7XG4gICAgICAgICAgICAgICAgICAgIHVybDogcHJvdmlkZXIgPT09ICdvbGxhbWEnXG4gICAgICAgICAgICAgICAgICAgICAgICA/IGAke25vcm1hbGl6ZUJhc2VVcmwob2xsYW1hVXJsKSB8fCBPTExBTUFfREVGQVVMVF9VUkx9L2FwaS9jaGF0YFxuICAgICAgICAgICAgICAgICAgICAgICAgOiBERUVQU0VFS19BUElfVVJMLFxuICAgICAgICAgICAgICAgICAgICBtZXRob2Q6ICdQT1NUJyBhcyBjb25zdCxcbiAgICAgICAgICAgICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICAgICAgICAgICAgYm9keTogcHJvdmlkZXIgPT09ICdvbGxhbWEnXG4gICAgICAgICAgICAgICAgICAgICAgICA/IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBtb2RlbDogb2xsYW1hTW9kZWwsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbWVzc2FnZXMsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3RyZWFtOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25zOiB7IHRlbXBlcmF0dXJlOiAwLjMgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgICAgICAgICA6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBtb2RlbCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBtZXNzYWdlcyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0ZW1wZXJhdHVyZTogMC4zLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG1heF90b2tlbnM6IDUwMCxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgICAgICAgICAgICAgICAgIHJlcXVlc3RVcmwocmVxdWVzdFBhcmFtcyksXG4gICAgICAgICAgICAgICAgICAgIHRpbWVvdXRQcm9taXNlKHRpbWVvdXQpLFxuICAgICAgICAgICAgICAgIF0pO1xuXG4gICAgICAgICAgICAgICAgaWYgKHJlc3BvbnNlLnN0YXR1cyA8IDIwMCB8fCByZXNwb25zZS5zdGF0dXMgPj0gMzAwKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQVBJICR7cmVzcG9uc2Uuc3RhdHVzfTogJHtyZXNwb25zZS50ZXh0fWApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IG1zZyA9IHByb3ZpZGVyID09PSAnb2xsYW1hJ1xuICAgICAgICAgICAgICAgICAgICA/ICgocmVzcG9uc2UuanNvbiBhcyBPbGxhbWFDaGF0UmVzcG9uc2UpLm1lc3NhZ2U/LmNvbnRlbnQgPz8gJycpLnRyaW0oKVxuICAgICAgICAgICAgICAgICAgICA6ICgocmVzcG9uc2UuanNvbiBhcyBEZWVwU2Vla1Jlc3BvbnNlKS5jaG9pY2VzPy5bMF0/Lm1lc3NhZ2U/LmNvbnRlbnQgPz8gJycpLnRyaW0oKTtcblxuICAgICAgICAgICAgICAgIGlmICghbXNnKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignRW1wdHkgcmVzcG9uc2UgZnJvbSBBUEknKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBtZXNzYWdlID0gY2xlYW5NZXNzYWdlKG1zZyk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9IGNhdGNoIChlOiB1bmtub3duKSB7XG4gICAgICAgICAgICAgICAgbGFzdEVycm9yID0gZTtcbiAgICAgICAgICAgICAgICBpZiAoYXR0ZW1wdCA8IFJFVFJJRVMgJiYgIWlzQWJvcnRFcnJvcihlKSkge1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gd2luZG93LnNldFRpbWVvdXQociwgMTAwMCAqIGF0dGVtcHQpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobWVzc2FnZSkge1xuICAgICAgICAgICAgY29uc3QgZ2l0TGVhdmVzID0gdGhpcy5hcHAud29ya3NwYWNlLmdldExlYXZlc09mVHlwZSgnZ2l0LXZpZXcnKTtcbiAgICAgICAgICAgIGlmIChnaXRMZWF2ZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHRleHRhcmVhID0gZ2l0TGVhdmVzWzBdLnZpZXcuY29udGFpbmVyRWwucXVlcnlTZWxlY3RvcignLmNvbW1pdC1tc2ctaW5wdXQnKTtcbiAgICAgICAgICAgICAgICBpZiAodGV4dGFyZWEgaW5zdGFuY2VvZiBIVE1MVGV4dEFyZWFFbGVtZW50KSB7XG4gICAgICAgICAgICAgICAgICAgIE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBIVE1MVGV4dEFyZWFFbGVtZW50LnByb3RvdHlwZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICd2YWx1ZSdcbiAgICAgICAgICAgICAgICAgICAgKSEuc2V0IS5jYWxsKHRleHRhcmVhLCBtZXNzYWdlKTtcbiAgICAgICAgICAgICAgICAgICAgdGV4dGFyZWEuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ2lucHV0JywgeyBidWJibGVzOiB0cnVlIH0pKTtcbiAgICAgICAgICAgICAgICAgICAgdGV4dGFyZWEuZm9jdXMoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIG5vdGljZS5oaWRlKCk7XG4gICAgICAgICAgICBjb25zdCBwcmV2aWV3ID0gbWVzc2FnZS5sZW5ndGggPiA2MCA/IG1lc3NhZ2Uuc3Vic3RyaW5nKDAsIDYwKSArICcuLi4nIDogbWVzc2FnZTtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoYERvbmUgXHUyMDE0ICR7cHJldmlld31gKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIG5vdGljZS5oaWRlKCk7XG4gICAgICAgICAgICBpZiAoaXNBYm9ydEVycm9yKGxhc3RFcnJvcikpIHtcbiAgICAgICAgICAgICAgICBuZXcgTm90aWNlKGBSZXF1ZXN0IHRpbWVkIG91dCAoJHt0aW1lb3V0IC8gMTAwMH1zKWApO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChwcm92aWRlciA9PT0gJ29sbGFtYScpIHtcbiAgICAgICAgICAgICAgICBuZXcgTm90aWNlKGAke2Vycm9yTWVzc2FnZShsYXN0RXJyb3IpfSBcdTIwMTQgaXMgT2xsYW1hIHJ1bm5pbmc/YCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG5ldyBOb3RpY2UoZXJyb3JNZXNzYWdlKGxhc3RFcnJvcikpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc29sZS5lcnJvcignQUkgQ29tbWl0IGVycm9yOicsIGxhc3RFcnJvcik7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLnNldEJ1dHRvbkxvYWRpbmcoZmFsc2UpO1xuICAgIH1cblxuICAgIHNldEJ1dHRvbkxvYWRpbmcodGhpczogdm9pZCwgbG9hZGluZzogYm9vbGVhbik6IHZvaWQge1xuICAgICAgICBjb25zdCBidG4gPSB3aW5kb3cuYWN0aXZlRG9jdW1lbnQucXVlcnlTZWxlY3RvcignI2FpLWNvbW1pdC1idG4nKTtcbiAgICAgICAgaWYgKCEoYnRuIGluc3RhbmNlb2YgSFRNTEVsZW1lbnQpKSByZXR1cm47XG4gICAgICAgIGlmIChsb2FkaW5nKSB7XG4gICAgICAgICAgICBidG4uYWRkQ2xhc3MoJ2FpLWNvbW1pdC1sb2FkaW5nJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBidG4ucmVtb3ZlQ2xhc3MoJ2FpLWNvbW1pdC1sb2FkaW5nJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBhc3luYyBsb2FkU2V0dGluZ3MoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgICAgIGNvbnN0IGRhdGEgPSBhd2FpdCB0aGlzLmxvYWREYXRhKCkgYXMgUGFydGlhbDxBSUNvbW1pdFNldHRpbmdzPjtcbiAgICAgICAgdGhpcy5zZXR0aW5ncyA9IE9iamVjdC5hc3NpZ24oe30sIERFRkFVTFRfU0VUVElOR1MsIGRhdGEpO1xuICAgIH1cblxuICAgIGFzeW5jIHNhdmVTZXR0aW5ncygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAgICAgYXdhaXQgdGhpcy5zYXZlRGF0YSh0aGlzLnNldHRpbmdzKTtcbiAgICB9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxzQkFBb0Y7QUFDcEYsMkJBQXlCO0FBRXpCLElBQU0sbUJBQW1CO0FBQ3pCLElBQU0seUJBQXlCO0FBQy9CLElBQU0scUJBQXFCO0FBQzNCLElBQU0sdUJBQXVCO0FBQzdCLElBQU0sVUFBVTtBQUVoQixJQUFNLHlCQUFpRDtBQUFBLEVBQ25ELHFCQUFxQjtBQUFBLEVBQ3JCLG1CQUFtQjtBQUN2QjtBQUlBLElBQU0sZ0JBQWdCO0FBQUEsRUFDbEI7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNKLEVBQUUsS0FBSyxJQUFJO0FBaUNYLElBQU0sbUJBQXFDO0FBQUEsRUFDdkMsVUFBVTtBQUFBLEVBQ1YsUUFBUTtBQUFBLEVBQ1IsT0FBTztBQUFBLEVBQ1AsV0FBVztBQUFBLEVBQ1gsYUFBYTtBQUFBLEVBQ2IsY0FBYztBQUFBLEVBQ2QsU0FBUztBQUNiO0FBRUEsU0FBUyxhQUFhLEtBQXFCO0FBQ3ZDLFNBQU8sSUFDRixRQUFRLG1CQUFtQixFQUFFLEVBQzdCLFFBQVEsWUFBWSxFQUFFLEVBQ3RCLFFBQVEsZ0JBQWdCLEVBQUUsRUFDMUIsUUFBUSx5QkFBeUIsRUFBRSxFQUNuQyxRQUFRLDJCQUEyQixFQUFF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
