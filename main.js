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
  onunload() {
    const leaves = this.app.workspace.getLeavesOfType("git-view");
    for (const leaf of leaves) {
      const el = leaf.view.containerEl;
      el.querySelector("#ai-commit-btn")?.remove();
      delete el.dataset.aiCommitObserved;
    }
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
        const observer = new MutationObserver(() => {
          this.injectButton();
        });
        observer.observe(el, { childList: true, subtree: true });
        this.register(() => observer.disconnect());
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsibWFpbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgQXBwLCBQbHVnaW4sIFBsdWdpblNldHRpbmdUYWIsIFNldHRpbmcsIE5vdGljZSwgc2V0SWNvbiwgcmVxdWVzdFVybCB9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCB7IGV4ZWNTeW5jIH0gZnJvbSAnY2hpbGRfcHJvY2Vzcyc7XG5cbmNvbnN0IERFRVBTRUVLX0FQSV9VUkwgPSAnaHR0cHM6Ly9hcGkuZGVlcHNlZWsuY29tL2NoYXQvY29tcGxldGlvbnMnO1xuY29uc3QgREVFUFNFRUtfREVGQVVMVF9NT0RFTCA9ICdkZWVwc2Vlay12NC1mbGFzaCc7XG5jb25zdCBPTExBTUFfREVGQVVMVF9VUkwgPSAnaHR0cDovL2xvY2FsaG9zdDoxMTQzNCc7XG5jb25zdCBPTExBTUFfREVGQVVMVF9NT0RFTCA9ICdsbGFtYTMuMSc7XG5jb25zdCBSRVRSSUVTID0gMztcblxuY29uc3QgREVFUFNFRUtfTU9ERUxfT1BUSU9OUzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgICAnZGVlcHNlZWstdjQtZmxhc2gnOiAnRGVlcFNlZWsgVjQgRmxhc2gnLFxuICAgICdkZWVwc2Vlay12NC1wcm8nOiAnRGVlcFNlZWsgVjQgUHJvJyxcbn07XG5cbnR5cGUgUHJvdmlkZXIgPSAnZGVlcHNlZWsnIHwgJ29sbGFtYSc7XG5cbmNvbnN0IFNZU1RFTV9QUk9NUFQgPSBbXG4gICAgJ1lvdSBhcmUgYW4gZXhwZXJ0IGF0IHdyaXRpbmcgZ2l0IGNvbW1pdCBtZXNzYWdlcy4nLFxuICAgICdXcml0ZSBhIHNob3J0LCBkZXNjcmlwdGl2ZSBjb21taXQgbWVzc2FnZSBpbiBwbGFpbiBsYW5ndWFnZS4nLFxuICAgICdEbyBOT1QgdXNlIENvbnZlbnRpb25hbCBDb21taXRzIGZvcm1hdCAobm8gXCJ0eXBlOlwiIG9yIFwidHlwZShzY29wZSk6XCIgcHJlZml4ZXMpLicsXG4gICAgJ1dyaXRlIE9OTFkgdGhlIGNvbW1pdCBtZXNzYWdlIFx1MjAxNCBubyBleHBsYW5hdGlvbnMsIG5vIG1hcmtkb3duIGZlbmNlcywgbm8gcXVvdGVzLicsXG4gICAgJ091dHB1dCBhIGNvbXBsZXRlIHNlbnRlbmNlLiBEbyBub3QgdHJ1bmNhdGUgbWlkLXdvcmQuJyxcbiAgICAnRm9jdXMgb24gV0hBVCBjaGFuZ2VkIGFuZCBXSFksIG5vdCBIT1cuJyxcbl0uam9pbignXFxuJyk7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQUlDb21taXRTZXR0aW5ncyB7XG4gICAgcHJvdmlkZXI6IFByb3ZpZGVyO1xuICAgIGFwaUtleTogc3RyaW5nO1xuICAgIG1vZGVsOiBzdHJpbmc7XG4gICAgb2xsYW1hVXJsOiBzdHJpbmc7XG4gICAgb2xsYW1hTW9kZWw6IHN0cmluZztcbiAgICBjdXN0b21Qcm9tcHQ6IHN0cmluZztcbiAgICB0aW1lb3V0OiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBEZWVwU2Vla1Jlc3BvbnNlIHtcbiAgICBjaG9pY2VzPzogQXJyYXk8e1xuICAgICAgICBtZXNzYWdlPzoge1xuICAgICAgICAgICAgY29udGVudD86IHN0cmluZztcbiAgICAgICAgfTtcbiAgICB9Pjtcbn1cblxuaW50ZXJmYWNlIE9sbGFtYUNoYXRSZXNwb25zZSB7XG4gICAgbWVzc2FnZT86IHtcbiAgICAgICAgY29udGVudD86IHN0cmluZztcbiAgICB9O1xufVxuXG5pbnRlcmZhY2UgT2xsYW1hVGFnc1Jlc3BvbnNlIHtcbiAgICBtb2RlbHM/OiBBcnJheTx7XG4gICAgICAgIG5hbWU/OiBzdHJpbmc7XG4gICAgICAgIG1vZGVsPzogc3RyaW5nO1xuICAgIH0+O1xufVxuXG5jb25zdCBERUZBVUxUX1NFVFRJTkdTOiBBSUNvbW1pdFNldHRpbmdzID0ge1xuICAgIHByb3ZpZGVyOiAnZGVlcHNlZWsnLFxuICAgIGFwaUtleTogJycsXG4gICAgbW9kZWw6IERFRVBTRUVLX0RFRkFVTFRfTU9ERUwsXG4gICAgb2xsYW1hVXJsOiBPTExBTUFfREVGQVVMVF9VUkwsXG4gICAgb2xsYW1hTW9kZWw6IE9MTEFNQV9ERUZBVUxUX01PREVMLFxuICAgIGN1c3RvbVByb21wdDogJycsXG4gICAgdGltZW91dDogMzAwMDAsXG59O1xuXG5mdW5jdGlvbiBjbGVhbk1lc3NhZ2UocmF3OiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIHJldHVybiByYXdcbiAgICAgICAgLnJlcGxhY2UoL15gYGBbYS16XSpcXG4/L2ltLCAnJylcbiAgICAgICAgLnJlcGxhY2UoL1xcbj9gYGAkL20sICcnKVxuICAgICAgICAucmVwbGFjZSgvXltcIiddfFtcIiddJC9nLCAnJylcbiAgICAgICAgLnJlcGxhY2UoL15jb21taXQgbWVzc2FnZTpcXHMqL2ltLCAnJylcbiAgICAgICAgLnJlcGxhY2UoL15cXHcrKFxcKFteKV0qXFwpKT8hPzpcXHMqL2ksICcnKVxuICAgICAgICAudHJpbSgpO1xufVxuXG5mdW5jdGlvbiBpc0Vycm9yKGU6IHVua25vd24pOiBlIGlzIEVycm9yIHtcbiAgICByZXR1cm4gZSBpbnN0YW5jZW9mIEVycm9yO1xufVxuXG5mdW5jdGlvbiBpc0Fib3J0RXJyb3IoZTogdW5rbm93bik6IGJvb2xlYW4ge1xuICAgIHJldHVybiBpc0Vycm9yKGUpICYmIGUubmFtZSA9PT0gJ0Fib3J0RXJyb3InO1xufVxuXG5mdW5jdGlvbiBlcnJvck1lc3NhZ2UoZTogdW5rbm93bik6IHN0cmluZyB7XG4gICAgaWYgKGlzRXJyb3IoZSkpIHtcbiAgICAgICAgcmV0dXJuIGUubWVzc2FnZTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBlID09PSAnc3RyaW5nJykge1xuICAgICAgICByZXR1cm4gZTtcbiAgICB9XG4gICAgcmV0dXJuICdVbmtub3duIGVycm9yJztcbn1cblxuZnVuY3Rpb24gdGltZW91dFByb21pc2UobXM6IG51bWJlcik6IFByb21pc2U8bmV2ZXI+IHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKF8sIHJlamVjdCkgPT5cbiAgICAgICAgd2luZG93LnNldFRpbWVvdXQoKCkgPT4gcmVqZWN0KG5ldyBET01FeGNlcHRpb24oJ1JlcXVlc3QgdGltZWQgb3V0JywgJ0Fib3J0RXJyb3InKSksIG1zKVxuICAgICk7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUJhc2VVcmwodXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIHJldHVybiB1cmwudHJpbSgpLnJlcGxhY2UoL1xcLyskLywgJycpO1xufVxuXG5jbGFzcyBBSUNvbW1pdFNldHRpbmdUYWIgZXh0ZW5kcyBQbHVnaW5TZXR0aW5nVGFiIHtcbiAgICBwbHVnaW46IEFJQ29tbWl0UGx1Z2luO1xuXG4gICAgY29uc3RydWN0b3IoYXBwOiBBcHAsIHBsdWdpbjogQUlDb21taXRQbHVnaW4pIHtcbiAgICAgICAgc3VwZXIoYXBwLCBwbHVnaW4pO1xuICAgICAgICB0aGlzLnBsdWdpbiA9IHBsdWdpbjtcbiAgICB9XG5cbiAgICBkaXNwbGF5KCk6IHZvaWQge1xuICAgICAgICBjb25zdCB7IGNvbnRhaW5lckVsIH0gPSB0aGlzO1xuICAgICAgICBjb250YWluZXJFbC5lbXB0eSgpO1xuXG4gICAgICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgICAgICAgLnNldE5hbWUoJ1Byb3ZpZGVyJylcbiAgICAgICAgICAgIC5zZXREZXNjKCdBSSBwcm92aWRlciB1c2VkIHRvIGdlbmVyYXRlIGNvbW1pdCBtZXNzYWdlcycpXG4gICAgICAgICAgICAuYWRkRHJvcGRvd24oKGRyb3Bkb3duKSA9PiB7XG4gICAgICAgICAgICAgICAgZHJvcGRvd24uYWRkT3B0aW9uKCdkZWVwc2VlaycsICdEZWVwU2VlayAoY2xvdWQpJyk7XG4gICAgICAgICAgICAgICAgZHJvcGRvd24uYWRkT3B0aW9uKCdvbGxhbWEnLCAnT2xsYW1hIChsb2NhbCknKTtcbiAgICAgICAgICAgICAgICBkcm9wZG93bi5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5wcm92aWRlcik7XG4gICAgICAgICAgICAgICAgZHJvcGRvd24ub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnByb3ZpZGVyID0gdmFsdWUgYXMgUHJvdmlkZXI7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmRpc3BsYXkoKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgIGlmICh0aGlzLnBsdWdpbi5zZXR0aW5ncy5wcm92aWRlciA9PT0gJ29sbGFtYScpIHtcbiAgICAgICAgICAgIHRoaXMuZGlzcGxheU9sbGFtYVNldHRpbmdzKGNvbnRhaW5lckVsKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuZGlzcGxheURlZXBTZWVrU2V0dGluZ3MoY29udGFpbmVyRWwpO1xuICAgICAgICB9XG5cbiAgICAgICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAgICAgICAuc2V0TmFtZSgnVGltZW91dCcpXG4gICAgICAgICAgICAuc2V0RGVzYygnQVBJIHJlcXVlc3QgdGltZW91dCBpbiBzZWNvbmRzJylcbiAgICAgICAgICAgIC5hZGRTbGlkZXIoKHNsaWRlcikgPT4ge1xuICAgICAgICAgICAgICAgIHNsaWRlclxuICAgICAgICAgICAgICAgICAgICAuc2V0TGltaXRzKDEwLCAxMjAsIDUpXG4gICAgICAgICAgICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy50aW1lb3V0IC8gMTAwMClcbiAgICAgICAgICAgICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MudGltZW91dCA9IHZhbHVlICogMTAwMDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgICAgICAgLnNldE5hbWUoJ0N1c3RvbSBpbnN0cnVjdGlvbnMnKVxuICAgICAgICAgICAgLnNldERlc2MoJ0FwcGVuZGVkIHRvIHRoZSBzeXN0ZW0gcHJvbXB0IChsYW5ndWFnZSwgc3R5bGUsIGV4dHJhIHJ1bGVzKScpXG4gICAgICAgICAgICAuYWRkVGV4dEFyZWEoKHRleHQpID0+IHtcbiAgICAgICAgICAgICAgICB0ZXh0XG4gICAgICAgICAgICAgICAgICAgIC5zZXRQbGFjZWhvbGRlcignV3JpdGUgY29uY2lzZSBjb21taXQgbWVzc2FnZXMnKVxuICAgICAgICAgICAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuY3VzdG9tUHJvbXB0KVxuICAgICAgICAgICAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5jdXN0b21Qcm9tcHQgPSB2YWx1ZS50cmltKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgdGV4dC5pbnB1dEVsLnJvd3MgPSAzO1xuICAgICAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgcHJpdmF0ZSBkaXNwbGF5RGVlcFNlZWtTZXR0aW5ncyhjb250YWluZXJFbDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgICAgICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAgICAgICAuc2V0TmFtZSgnRGVlcFNlZWsgQVBJIGtleScpXG4gICAgICAgICAgICAuc2V0RGVzYygnRGVlcFNlZWsgQVBJIGtleScpXG4gICAgICAgICAgICAuYWRkVGV4dCgodGV4dCkgPT4ge1xuICAgICAgICAgICAgICAgIHRleHRcbiAgICAgICAgICAgICAgICAgICAgLnNldFBsYWNlaG9sZGVyKCdTay1cdTIwMjYnKVxuICAgICAgICAgICAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuYXBpS2V5KVxuICAgICAgICAgICAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5hcGlLZXkgPSB2YWx1ZS50cmltKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgdGV4dC5pbnB1dEVsLnR5cGUgPSAncGFzc3dvcmQnO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAgICAgICAuc2V0TmFtZSgnTW9kZWwnKVxuICAgICAgICAgICAgLnNldERlc2MoJ0RlZXBTZWVrIG1vZGVsIGZvciBjb21taXQgbWVzc2FnZSBnZW5lcmF0aW9uJylcbiAgICAgICAgICAgIC5hZGREcm9wZG93bigoZHJvcGRvd24pID0+IHtcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhERUVQU0VFS19NT0RFTF9PUFRJT05TKSkge1xuICAgICAgICAgICAgICAgICAgICBkcm9wZG93bi5hZGRPcHRpb24oa2V5LCBERUVQU0VFS19NT0RFTF9PUFRJT05TW2tleV0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBkcm9wZG93bi5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5tb2RlbCk7XG4gICAgICAgICAgICAgICAgZHJvcGRvd24ub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLm1vZGVsID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgcHJpdmF0ZSBkaXNwbGF5T2xsYW1hU2V0dGluZ3MoY29udGFpbmVyRWw6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gICAgICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgICAgICAgLnNldE5hbWUoJ09sbGFtYSBzZXJ2ZXIgVVJMJylcbiAgICAgICAgICAgIC5zZXREZXNjKCdCYXNlIFVSTCBvZiB5b3VyIGxvY2FsIG9sbGFtYSBzZXJ2ZXInKVxuICAgICAgICAgICAgLmFkZFRleHQoKHRleHQpID0+IHtcbiAgICAgICAgICAgICAgICB0ZXh0XG4gICAgICAgICAgICAgICAgICAgIC5zZXRQbGFjZWhvbGRlcihPTExBTUFfREVGQVVMVF9VUkwpXG4gICAgICAgICAgICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5vbGxhbWFVcmwpXG4gICAgICAgICAgICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLm9sbGFtYVVybCA9IG5vcm1hbGl6ZUJhc2VVcmwodmFsdWUpIHx8IE9MTEFNQV9ERUZBVUxUX1VSTDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IG1vZGVsU2V0dGluZyA9IG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgICAgICAgLnNldE5hbWUoJ09sbGFtYSBtb2RlbCcpXG4gICAgICAgICAgICAuc2V0RGVzYygnTmFtZSBvZiBhIG1vZGVsIHB1bGxlZCBpbiBvbGxhbWEgKGUuZy4gXCJsbGFtYTMuMVwiIG9yIFwicXdlbjIuNS1jb2RlclwiKScpO1xuXG4gICAgICAgIGlmICh0aGlzLnBsdWdpbi5kZXRlY3RlZE9sbGFtYU1vZGVscy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBtb2RlbFNldHRpbmcuYWRkRHJvcGRvd24oKGRyb3Bkb3duKSA9PiB7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBuYW1lIG9mIHRoaXMucGx1Z2luLmRldGVjdGVkT2xsYW1hTW9kZWxzKSB7XG4gICAgICAgICAgICAgICAgICAgIGRyb3Bkb3duLmFkZE9wdGlvbihuYW1lLCBuYW1lKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5vbGxhbWFNb2RlbCAmJlxuICAgICAgICAgICAgICAgICAgICAhdGhpcy5wbHVnaW4uZGV0ZWN0ZWRPbGxhbWFNb2RlbHMuaW5jbHVkZXModGhpcy5wbHVnaW4uc2V0dGluZ3Mub2xsYW1hTW9kZWwpXG4gICAgICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgICAgIGRyb3Bkb3duLmFkZE9wdGlvbih0aGlzLnBsdWdpbi5zZXR0aW5ncy5vbGxhbWFNb2RlbCwgdGhpcy5wbHVnaW4uc2V0dGluZ3Mub2xsYW1hTW9kZWwpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBkcm9wZG93bi5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5vbGxhbWFNb2RlbCk7XG4gICAgICAgICAgICAgICAgZHJvcGRvd24ub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLm9sbGFtYU1vZGVsID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBtb2RlbFNldHRpbmcuYWRkVGV4dCgodGV4dCkgPT4ge1xuICAgICAgICAgICAgICAgIHRleHRcbiAgICAgICAgICAgICAgICAgICAgLnNldFBsYWNlaG9sZGVyKE9MTEFNQV9ERUZBVUxUX01PREVMKVxuICAgICAgICAgICAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3Mub2xsYW1hTW9kZWwpXG4gICAgICAgICAgICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLm9sbGFtYU1vZGVsID0gdmFsdWUudHJpbSgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBtb2RlbFNldHRpbmcuYWRkRXh0cmFCdXR0b24oKGJ1dHRvbikgPT4ge1xuICAgICAgICAgICAgYnV0dG9uXG4gICAgICAgICAgICAgICAgLnNldEljb24oJ3JlZnJlc2gtY3cnKVxuICAgICAgICAgICAgICAgIC5zZXRUb29sdGlwKCdEZXRlY3QgaW5zdGFsbGVkIG1vZGVscycpXG4gICAgICAgICAgICAgICAgLm9uQ2xpY2soYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBidXR0b24uc2V0RGlzYWJsZWQodHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBtb2RlbHMgPSBhd2FpdCB0aGlzLnBsdWdpbi5mZXRjaE9sbGFtYU1vZGVscygpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKG1vZGVscy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBuZXcgTm90aWNlKCdObyBtb2RlbHMgZm91bmQgXHUyMDE0IHB1bGwgb25lIHdpdGggYG9sbGFtYSBwdWxsIDxtb2RlbD5gJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luLmRldGVjdGVkT2xsYW1hTW9kZWxzID0gbW9kZWxzO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghdGhpcy5wbHVnaW4uc2V0dGluZ3Mub2xsYW1hTW9kZWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3Mub2xsYW1hTW9kZWwgPSBtb2RlbHNbMF07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmRpc3BsYXkoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZTogdW5rbm93bikge1xuICAgICAgICAgICAgICAgICAgICAgICAgbmV3IE5vdGljZShgQ291bGQgbm90IHJlYWNoIE9sbGFtYSBcdTIwMTQgJHtlcnJvck1lc3NhZ2UoZSl9YCk7XG4gICAgICAgICAgICAgICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBidXR0b24uc2V0RGlzYWJsZWQoZmFsc2UpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgQUlDb21taXRQbHVnaW4gZXh0ZW5kcyBQbHVnaW4ge1xuICAgIGRlY2xhcmUgc2V0dGluZ3M6IEFJQ29tbWl0U2V0dGluZ3M7XG4gICAgZGV0ZWN0ZWRPbGxhbWFNb2RlbHM6IHN0cmluZ1tdID0gW107XG5cbiAgICBhc3luYyBvbmxvYWQoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgICAgIGF3YWl0IHRoaXMubG9hZFNldHRpbmdzKCk7XG4gICAgICAgIHRoaXMuYWRkU2V0dGluZ1RhYihuZXcgQUlDb21taXRTZXR0aW5nVGFiKHRoaXMuYXBwLCB0aGlzKSk7XG5cbiAgICAgICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgICAgICAgIGlkOiAnZ2VuZXJhdGUtY29tbWl0LW1lc3NhZ2UnLFxuICAgICAgICAgICAgbmFtZTogJ0dlbmVyYXRlIGNvbW1pdCBtZXNzYWdlJyxcbiAgICAgICAgICAgIGNhbGxiYWNrOiAoKSA9PiB7XG4gICAgICAgICAgICAgICAgdm9pZCB0aGlzLmdlbmVyYXRlQW5kRmlsbCgpO1xuICAgICAgICAgICAgfSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KFxuICAgICAgICAgICAgdGhpcy5hcHAud29ya3NwYWNlLm9uKCdsYXlvdXQtY2hhbmdlJywgKCkgPT4ge1xuICAgICAgICAgICAgICAgIHRoaXMuaW5qZWN0QnV0dG9uKCk7XG4gICAgICAgICAgICB9KVxuICAgICAgICApO1xuXG4gICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5vbkxheW91dFJlYWR5KCgpID0+IHtcbiAgICAgICAgICAgIHRoaXMuaW5qZWN0QnV0dG9uKCk7XG4gICAgICAgICAgICB0aGlzLm9ic2VydmVHaXRWaWV3KCk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIG9udW5sb2FkKCk6IHZvaWQge1xuICAgICAgICAvLyBQcmV2ZW50cyBzdGFsZSBidXR0b24gYm91bmQgdG8gZGVhZCBpbnN0YW5jZS5cbiAgICAgICAgY29uc3QgbGVhdmVzID0gdGhpcy5hcHAud29ya3NwYWNlLmdldExlYXZlc09mVHlwZSgnZ2l0LXZpZXcnKTtcbiAgICAgICAgZm9yIChjb25zdCBsZWFmIG9mIGxlYXZlcykge1xuICAgICAgICAgICAgY29uc3QgZWwgPSBsZWFmLnZpZXcuY29udGFpbmVyRWw7XG4gICAgICAgICAgICBlbC5xdWVyeVNlbGVjdG9yKCcjYWktY29tbWl0LWJ0bicpPy5yZW1vdmUoKTtcbiAgICAgICAgICAgIGRlbGV0ZSBlbC5kYXRhc2V0LmFpQ29tbWl0T2JzZXJ2ZWQ7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBpbmplY3RCdXR0b24odGhpczogdm9pZCk6IHZvaWQge1xuICAgICAgICBjb25zdCBsZWF2ZXMgPSAodGhpcyBhcyB1bmtub3duIGFzIEFJQ29tbWl0UGx1Z2luKS5hcHAud29ya3NwYWNlLmdldExlYXZlc09mVHlwZSgnZ2l0LXZpZXcnKTtcbiAgICAgICAgY29uc3QgcGx1Z2luID0gdGhpcyBhcyB1bmtub3duIGFzIEFJQ29tbWl0UGx1Z2luO1xuICAgICAgICBjb25zdCBkb2MgPSB3aW5kb3cuYWN0aXZlRG9jdW1lbnQ7XG4gICAgICAgIGZvciAoY29uc3QgbGVhZiBvZiBsZWF2ZXMpIHtcbiAgICAgICAgICAgIGNvbnN0IGNvbnRhaW5lciA9IGxlYWYudmlldy5jb250YWluZXJFbC5xdWVyeVNlbGVjdG9yKCcubmF2LWJ1dHRvbnMtY29udGFpbmVyJyk7XG4gICAgICAgICAgICBpZiAoIWNvbnRhaW5lciB8fCBjb250YWluZXIucXVlcnlTZWxlY3RvcignI2FpLWNvbW1pdC1idG4nKSkgY29udGludWU7XG5cbiAgICAgICAgICAgIGNvbnN0IGJ0biA9IGRvYy5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgICAgIGJ0bi5pZCA9ICdhaS1jb21taXQtYnRuJztcbiAgICAgICAgICAgIGJ0bi5jbGFzc05hbWUgPSAnY2xpY2thYmxlLWljb24gbmF2LWFjdGlvbi1idXR0b24gYWktY29tbWl0LWJ0bic7XG4gICAgICAgICAgICBidG4uc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgJ0dlbmVyYXRlIGNvbW1pdCBtZXNzYWdlJyk7XG4gICAgICAgICAgICBzZXRJY29uKGJ0biwgJ3NwYXJrbGVzJyk7XG4gICAgICAgICAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICAgICAgdm9pZCBwbHVnaW4uZ2VuZXJhdGVBbmRGaWxsKCk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgY29uc3QgY29tbWl0QnRuID0gY29udGFpbmVyLnF1ZXJ5U2VsZWN0b3IoJyNjb21taXQtYnRuJyk7XG4gICAgICAgICAgICBpZiAoY29tbWl0QnRuKSB7XG4gICAgICAgICAgICAgICAgY29tbWl0QnRuLmJlZm9yZShidG4pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250YWluZXIuYXBwZW5kQ2hpbGQoYnRuKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIG9ic2VydmVHaXRWaWV3KCk6IHZvaWQge1xuICAgICAgICBjb25zdCBoYW5kbGVyID0gKCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgbGVhdmVzID0gdGhpcy5hcHAud29ya3NwYWNlLmdldExlYXZlc09mVHlwZSgnZ2l0LXZpZXcnKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgbGVhZiBvZiBsZWF2ZXMpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBlbCA9IGxlYWYudmlldy5jb250YWluZXJFbDtcbiAgICAgICAgICAgICAgICBpZiAoZWwuZGF0YXNldC5haUNvbW1pdE9ic2VydmVkKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICBlbC5kYXRhc2V0LmFpQ29tbWl0T2JzZXJ2ZWQgPSAnMSc7XG4gICAgICAgICAgICAgICAgY29uc3Qgb2JzZXJ2ZXIgPSBuZXcgTXV0YXRpb25PYnNlcnZlcigoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuaW5qZWN0QnV0dG9uKCk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgb2JzZXJ2ZXIub2JzZXJ2ZShlbCwgeyBjaGlsZExpc3Q6IHRydWUsIHN1YnRyZWU6IHRydWUgfSk7XG4gICAgICAgICAgICAgICAgdGhpcy5yZWdpc3RlcigoKSA9PiBvYnNlcnZlci5kaXNjb25uZWN0KCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9O1xuICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQodGhpcy5hcHAud29ya3NwYWNlLm9uKCdsYXlvdXQtY2hhbmdlJywgaGFuZGxlcikpO1xuICAgICAgICBoYW5kbGVyKCk7XG4gICAgfVxuXG4gICAgYXN5bmMgZmV0Y2hPbGxhbWFNb2RlbHMoKTogUHJvbWlzZTxzdHJpbmdbXT4ge1xuICAgICAgICBjb25zdCBiYXNlVXJsID0gbm9ybWFsaXplQmFzZVVybCh0aGlzLnNldHRpbmdzLm9sbGFtYVVybCkgfHwgT0xMQU1BX0RFRkFVTFRfVVJMO1xuICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHJlcXVlc3RVcmwoe1xuICAgICAgICAgICAgdXJsOiBgJHtiYXNlVXJsfS9hcGkvdGFnc2AsXG4gICAgICAgICAgICBtZXRob2Q6ICdHRVQnLFxuICAgICAgICB9KTtcblxuICAgICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzIDwgMjAwIHx8IHJlc3BvbnNlLnN0YXR1cyA+PSAzMDApIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgT2xsYW1hICR7cmVzcG9uc2Uuc3RhdHVzfTogJHtyZXNwb25zZS50ZXh0fWApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgZGF0YSA9IHJlc3BvbnNlLmpzb24gYXMgT2xsYW1hVGFnc1Jlc3BvbnNlO1xuICAgICAgICByZXR1cm4gKGRhdGEubW9kZWxzID8/IFtdKVxuICAgICAgICAgICAgLm1hcCgobSkgPT4gbS5uYW1lID8/IG0ubW9kZWwgPz8gJycpXG4gICAgICAgICAgICAuZmlsdGVyKChuYW1lKSA9PiBuYW1lLmxlbmd0aCA+IDApO1xuICAgIH1cblxuICAgIGFzeW5jIGdlbmVyYXRlQW5kRmlsbCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAgICAgY29uc3QgeyBwcm92aWRlciwgYXBpS2V5LCBtb2RlbCwgb2xsYW1hVXJsLCBvbGxhbWFNb2RlbCwgY3VzdG9tUHJvbXB0LCB0aW1lb3V0IH0gPSB0aGlzLnNldHRpbmdzO1xuXG4gICAgICAgIGlmIChwcm92aWRlciA9PT0gJ2RlZXBzZWVrJyAmJiAhYXBpS2V5KSB7XG4gICAgICAgICAgICBuZXcgTm90aWNlKCdTZXQgRGVlcFNlZWsgQVBJIGtleSBpbiBzZXR0aW5ncycpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwcm92aWRlciA9PT0gJ29sbGFtYScgJiYgIW9sbGFtYU1vZGVsLnRyaW0oKSkge1xuICAgICAgICAgICAgbmV3IE5vdGljZSgnU2V0IG9sbGFtYSBtb2RlbCBpbiBzZXR0aW5ncycpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgdmF1bHRQYXRoID0gKHRoaXMuYXBwLnZhdWx0LmFkYXB0ZXIgYXMgeyBiYXNlUGF0aD86IHN0cmluZyB9KS5iYXNlUGF0aDtcbiAgICAgICAgaWYgKCF2YXVsdFBhdGgpIHtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoJ0Nhbm5vdCBkZXRlcm1pbmUgdmF1bHQgcGF0aCcpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRpZmY6IHN0cmluZztcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGV4ZWNTeW5jKCdnaXQgZGlmZiAtLWNhY2hlZCcsIHtcbiAgICAgICAgICAgICAgICBjd2Q6IHZhdWx0UGF0aCxcbiAgICAgICAgICAgICAgICBlbmNvZGluZzogJ3V0Zi04JyxcbiAgICAgICAgICAgICAgICBtYXhCdWZmZXI6IDEwICogMTAyNCAqIDEwMjQsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGRpZmYgPSByZXN1bHQudG9TdHJpbmcoKTtcbiAgICAgICAgfSBjYXRjaCAoZTogdW5rbm93bikge1xuICAgICAgICAgICAgbmV3IE5vdGljZShgR2l0IGVycm9yIFx1MjAxNCAke2Vycm9yTWVzc2FnZShlKX1gKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghZGlmZi50cmltKCkpIHtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoJ05vIHN0YWdlZCBjaGFuZ2VzJyk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB0cnVuY2F0ZWREaWZmID0gZGlmZi5sZW5ndGggPiA4MDAwXG4gICAgICAgICAgICA/IGRpZmYuc3Vic3RyaW5nKDAsIDgwMDApICsgJ1xcbi4uLmRpZmYgdHJ1bmNhdGVkJ1xuICAgICAgICAgICAgOiBkaWZmO1xuXG4gICAgICAgIGNvbnN0IG5vdGljZSA9IG5ldyBOb3RpY2UoJ0dlbmVyYXRpbmcuLi4nLCAwKTtcbiAgICAgICAgdGhpcy5zZXRCdXR0b25Mb2FkaW5nKHRydWUpO1xuXG4gICAgICAgIGxldCBtZXNzYWdlID0gJyc7XG4gICAgICAgIGxldCBsYXN0RXJyb3I6IHVua25vd247XG5cbiAgICAgICAgZm9yIChsZXQgYXR0ZW1wdCA9IDE7IGF0dGVtcHQgPD0gUkVUUklFUzsgYXR0ZW1wdCsrKSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGlmIChhdHRlbXB0ID4gMSkge1xuICAgICAgICAgICAgICAgICAgICBub3RpY2Uuc2V0TWVzc2FnZShgR2VuZXJhdGluZy4uLiAoYXR0ZW1wdCAke2F0dGVtcHR9LyR7UkVUUklFU30pYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3Qgc3lzdGVtUHJvbXB0ID0gY3VzdG9tUHJvbXB0XG4gICAgICAgICAgICAgICAgICAgID8gU1lTVEVNX1BST01QVCArICdcXG4nICsgY3VzdG9tUHJvbXB0XG4gICAgICAgICAgICAgICAgICAgIDogU1lTVEVNX1BST01QVDtcblxuICAgICAgICAgICAgICAgIGNvbnN0IG1lc3NhZ2VzID0gW1xuICAgICAgICAgICAgICAgICAgICB7IHJvbGU6ICdzeXN0ZW0nLCBjb250ZW50OiBzeXN0ZW1Qcm9tcHQgfSxcbiAgICAgICAgICAgICAgICAgICAgeyByb2xlOiAndXNlcicsIGNvbnRlbnQ6IGBXcml0ZSBhIGNvbW1pdCBtZXNzYWdlIGZvcjpcXG5cXG4ke3RydW5jYXRlZERpZmZ9YCB9LFxuICAgICAgICAgICAgICAgIF07XG5cbiAgICAgICAgICAgICAgICBjb25zdCBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0geyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH07XG4gICAgICAgICAgICAgICAgaWYgKHByb3ZpZGVyID09PSAnZGVlcHNlZWsnKSB7XG4gICAgICAgICAgICAgICAgICAgIGhlYWRlcnNbJ0F1dGhvcml6YXRpb24nXSA9IGBCZWFyZXIgJHthcGlLZXl9YDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCByZXF1ZXN0UGFyYW1zID0ge1xuICAgICAgICAgICAgICAgICAgICB1cmw6IHByb3ZpZGVyID09PSAnb2xsYW1hJ1xuICAgICAgICAgICAgICAgICAgICAgICAgPyBgJHtub3JtYWxpemVCYXNlVXJsKG9sbGFtYVVybCkgfHwgT0xMQU1BX0RFRkFVTFRfVVJMfS9hcGkvY2hhdGBcbiAgICAgICAgICAgICAgICAgICAgICAgIDogREVFUFNFRUtfQVBJX1VSTCxcbiAgICAgICAgICAgICAgICAgICAgbWV0aG9kOiAnUE9TVCcgYXMgY29uc3QsXG4gICAgICAgICAgICAgICAgICAgIGhlYWRlcnMsXG4gICAgICAgICAgICAgICAgICAgIGJvZHk6IHByb3ZpZGVyID09PSAnb2xsYW1hJ1xuICAgICAgICAgICAgICAgICAgICAgICAgPyBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbW9kZWw6IG9sbGFtYU1vZGVsLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG1lc3NhZ2VzLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHN0cmVhbTogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgb3B0aW9uczogeyB0ZW1wZXJhdHVyZTogMC4zIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgICAgICAgICAgOiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbW9kZWwsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbWVzc2FnZXMsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGVtcGVyYXR1cmU6IDAuMyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBtYXhfdG9rZW5zOiA1MDAsXG4gICAgICAgICAgICAgICAgICAgICAgICB9KSxcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgICAgICAgICAgICAgICAgICByZXF1ZXN0VXJsKHJlcXVlc3RQYXJhbXMpLFxuICAgICAgICAgICAgICAgICAgICB0aW1lb3V0UHJvbWlzZSh0aW1lb3V0KSxcbiAgICAgICAgICAgICAgICBdKTtcblxuICAgICAgICAgICAgICAgIGlmIChyZXNwb25zZS5zdGF0dXMgPCAyMDAgfHwgcmVzcG9uc2Uuc3RhdHVzID49IDMwMCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFQSSAke3Jlc3BvbnNlLnN0YXR1c306ICR7cmVzcG9uc2UudGV4dH1gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBjb25zdCBtc2cgPSBwcm92aWRlciA9PT0gJ29sbGFtYSdcbiAgICAgICAgICAgICAgICAgICAgPyAoKHJlc3BvbnNlLmpzb24gYXMgT2xsYW1hQ2hhdFJlc3BvbnNlKS5tZXNzYWdlPy5jb250ZW50ID8/ICcnKS50cmltKClcbiAgICAgICAgICAgICAgICAgICAgOiAoKHJlc3BvbnNlLmpzb24gYXMgRGVlcFNlZWtSZXNwb25zZSkuY2hvaWNlcz8uWzBdPy5tZXNzYWdlPy5jb250ZW50ID8/ICcnKS50cmltKCk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIW1zZykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0VtcHR5IHJlc3BvbnNlIGZyb20gQVBJJyk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbWVzc2FnZSA9IGNsZWFuTWVzc2FnZShtc2cpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfSBjYXRjaCAoZTogdW5rbm93bikge1xuICAgICAgICAgICAgICAgIGxhc3RFcnJvciA9IGU7XG4gICAgICAgICAgICAgICAgaWYgKGF0dGVtcHQgPCBSRVRSSUVTICYmICFpc0Fib3J0RXJyb3IoZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHdpbmRvdy5zZXRUaW1lb3V0KHIsIDEwMDAgKiBhdHRlbXB0KSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG1lc3NhZ2UpIHtcbiAgICAgICAgICAgIGNvbnN0IGdpdExlYXZlcyA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRMZWF2ZXNPZlR5cGUoJ2dpdC12aWV3Jyk7XG4gICAgICAgICAgICBpZiAoZ2l0TGVhdmVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICBjb25zdCB0ZXh0YXJlYSA9IGdpdExlYXZlc1swXS52aWV3LmNvbnRhaW5lckVsLnF1ZXJ5U2VsZWN0b3IoJy5jb21taXQtbXNnLWlucHV0Jyk7XG4gICAgICAgICAgICAgICAgaWYgKHRleHRhcmVhIGluc3RhbmNlb2YgSFRNTFRleHRBcmVhRWxlbWVudCkge1xuICAgICAgICAgICAgICAgICAgICBPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgSFRNTFRleHRBcmVhRWxlbWVudC5wcm90b3R5cGUsXG4gICAgICAgICAgICAgICAgICAgICAgICAndmFsdWUnXG4gICAgICAgICAgICAgICAgICAgICkhLnNldCEuY2FsbCh0ZXh0YXJlYSwgbWVzc2FnZSk7XG4gICAgICAgICAgICAgICAgICAgIHRleHRhcmVhLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdpbnB1dCcsIHsgYnViYmxlczogdHJ1ZSB9KSk7XG4gICAgICAgICAgICAgICAgICAgIHRleHRhcmVhLmZvY3VzKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBub3RpY2UuaGlkZSgpO1xuICAgICAgICAgICAgY29uc3QgcHJldmlldyA9IG1lc3NhZ2UubGVuZ3RoID4gNjAgPyBtZXNzYWdlLnN1YnN0cmluZygwLCA2MCkgKyAnLi4uJyA6IG1lc3NhZ2U7XG4gICAgICAgICAgICBuZXcgTm90aWNlKGBEb25lIFx1MjAxNCAke3ByZXZpZXd9YCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBub3RpY2UuaGlkZSgpO1xuICAgICAgICAgICAgaWYgKGlzQWJvcnRFcnJvcihsYXN0RXJyb3IpKSB7XG4gICAgICAgICAgICAgICAgbmV3IE5vdGljZShgUmVxdWVzdCB0aW1lZCBvdXQgKCR7dGltZW91dCAvIDEwMDB9cylgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocHJvdmlkZXIgPT09ICdvbGxhbWEnKSB7XG4gICAgICAgICAgICAgICAgbmV3IE5vdGljZShgJHtlcnJvck1lc3NhZ2UobGFzdEVycm9yKX0gXHUyMDE0IGlzIE9sbGFtYSBydW5uaW5nP2ApO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBuZXcgTm90aWNlKGVycm9yTWVzc2FnZShsYXN0RXJyb3IpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ0FJIENvbW1pdCBlcnJvcjonLCBsYXN0RXJyb3IpO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5zZXRCdXR0b25Mb2FkaW5nKGZhbHNlKTtcbiAgICB9XG5cbiAgICBzZXRCdXR0b25Mb2FkaW5nKHRoaXM6IHZvaWQsIGxvYWRpbmc6IGJvb2xlYW4pOiB2b2lkIHtcbiAgICAgICAgY29uc3QgYnRuID0gd2luZG93LmFjdGl2ZURvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJyNhaS1jb21taXQtYnRuJyk7XG4gICAgICAgIGlmICghKGJ0biBpbnN0YW5jZW9mIEhUTUxFbGVtZW50KSkgcmV0dXJuO1xuICAgICAgICBpZiAobG9hZGluZykge1xuICAgICAgICAgICAgYnRuLmFkZENsYXNzKCdhaS1jb21taXQtbG9hZGluZycpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgYnRuLnJlbW92ZUNsYXNzKCdhaS1jb21taXQtbG9hZGluZycpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgbG9hZFNldHRpbmdzKCk6IFByb21pc2U8dm9pZD4ge1xuICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgdGhpcy5sb2FkRGF0YSgpIGFzIFBhcnRpYWw8QUlDb21taXRTZXR0aW5ncz47XG4gICAgICAgIHRoaXMuc2V0dGluZ3MgPSBPYmplY3QuYXNzaWduKHt9LCBERUZBVUxUX1NFVFRJTkdTLCBkYXRhKTtcbiAgICB9XG5cbiAgICBhc3luYyBzYXZlU2V0dGluZ3MoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgICAgIGF3YWl0IHRoaXMuc2F2ZURhdGEodGhpcy5zZXR0aW5ncyk7XG4gICAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsc0JBQW9GO0FBQ3BGLDJCQUF5QjtBQUV6QixJQUFNLG1CQUFtQjtBQUN6QixJQUFNLHlCQUF5QjtBQUMvQixJQUFN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
