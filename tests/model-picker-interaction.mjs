// Real keyboard regression for an isolated Obsidian settings window.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const endpoint = `http://127.0.0.1:${process.env.OBSIDIAN_TEST_PORT || '19222'}`;
async function connect(predicate) {
    const pages = await (await fetch(`${endpoint}/json/list`)).json();
    const page = pages.find(p => p.type === 'page' && predicate(p));
    assert.ok(page, JSON.stringify(pages.map(p => ({title: p.title, url: p.url}))));
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r, {once: true}));
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', e => {const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id);});
    const call = (method, params) => new Promise(resolve => {const next = ++id; pending.set(next, resolve); ws.send(JSON.stringify({id: next, method, params}));});
    return {ws, call, async evaluate(expression) {
        const m = await call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
        assert.ok(!m.result.exceptionDetails, JSON.stringify(m.result.exceptionDetails));
        return m.result.result.value;
    }};
}
const main = await connect(p => p.url === 'app://obsidian.md/index.html');
let settings;
try {
    await main.evaluate(`(async()=>{
        if(app.vault.adapter.basePath!=='/tmp/obsidian-pr1-runtime/vault')throw Error('Refusing personal vault');
        app.setting.close();
        await app.plugins.disablePlugin('ai-commit');await app.plugins.enablePlugin('ai-commit');
        const p=app.plugins.plugins['ai-commit'];
        Object.assign(p.settings,{provider:'ollama',ollamaUrl:'http://127.0.0.1:11434',ollamaModel:'llama3.1'});
        app.setting.open();app.setting.openTabById('ai-commit');
        await new Promise(r=>setTimeout(r,400));
    })()`);
    const separate = (await (await fetch(`${endpoint}/json/list`)).json()).some(p => p.title.startsWith('Settings'));
    settings = separate ? await connect(p => p.title.startsWith('Settings')) : main;
    await settings.evaluate(`window.pickerRow=name=>[...document.querySelectorAll('.setting-item')].find(e=>e.querySelector('.setting-item-name')?.textContent===name)`);
    assert.equal(await settings.evaluate(`!!pickerRow('Installed models')`),false);
    async function click(expression) {
        const point=await settings.evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        await settings.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
        await settings.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
        await new Promise(r=>setTimeout(r,500));
    }
    await click(`pickerRow('Ollama model').querySelector('.extra-setting-button')`);
    const options=await settings.evaluate(`[...document.querySelectorAll('.menu-item-title')].map(e=>e.textContent)`);
    assert.ok(options.includes('qwen2.5:0.5b'),JSON.stringify(options));
    await click(`[...document.querySelectorAll('.menu-item')].find(e=>e.textContent.includes('qwen2.5:0.5b'))`);
    assert.equal(await settings.evaluate(`pickerRow('Ollama model').querySelector('input').value`),'qwen2.5:0.5b');
    assert.equal(await main.evaluate(`app.plugins.plugins['ai-commit'].settings.ollamaModel`),'qwen2.5:0.5b');
    assert.equal(JSON.parse(fs.readFileSync('/tmp/obsidian-pr1-runtime/vault/.obsidian/plugins/ai-commit/data.json','utf8')).ollamaModel,'qwen2.5:0.5b');
    console.log('Trusted mouse selection updates the single input and saved model',options);
    await click(`pickerRow('Ollama model').querySelector('.extra-setting-button')`);
    for(const [key,code] of [['ArrowDown',40],['Enter',13]]) {
        await settings.call('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:code});
        await settings.call('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:code});
    }
    await new Promise(r=>setTimeout(r,300));
    assert.equal(await main.evaluate(`app.plugins.plugins['ai-commit'].settings.ollamaModel`),options[0]);
    assert.equal(await settings.evaluate(`!!document.querySelector('.menu')`),false);
    console.log('Trusted keyboard selection closes the menu and saves the first model');
    await settings.evaluate(`pickerRow('Ollama model').querySelector('input').focus()`);
    await settings.call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    await settings.call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    await settings.call('Input.insertText',{text:'custom-model:latest'});
    await new Promise(r=>setTimeout(r,250));
    assert.equal(await main.evaluate(`app.plugins.plugins['ai-commit'].settings.ollamaModel`),'custom-model:latest');
    assert.equal(JSON.parse(fs.readFileSync('/tmp/obsidian-pr1-runtime/vault/.obsidian/plugins/ai-commit/data.json','utf8')).ollamaModel,'custom-model:latest');
    console.log('Manual entry remains editable and saves');
    await main.evaluate(`(async()=>{app.setting.close();await app.plugins.disablePlugin('ai-commit');await app.plugins.enablePlugin('ai-commit');})()`);
    assert.equal(await main.evaluate(`app.plugins.plugins['ai-commit'].settings.ollamaModel`),'custom-model:latest');
    console.log('Manual entry persists across plugin reload');
} finally { if(settings && settings!==main) settings.ws.close();main.ws.close(); }
