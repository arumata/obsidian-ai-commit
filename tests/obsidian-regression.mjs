// Run against an isolated Obsidian instance with this plugin and Obsidian Git.
// OBSIDIAN_TEST_PORT defaults to 19222; the personal vault is never accepted.
import assert from 'node:assert/strict';
const port = process.env.OBSIDIAN_TEST_PORT || '19222';
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(pages.find(p => p.type === 'page' && p.url === 'app://obsidian.md/index.html').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, {once: true}));
async function probe() {
    if (app.vault.adapter.basePath !== '/tmp/obsidian-pr1-runtime/vault') throw new Error('Not the isolated test vault');
    const results = [];
    const check = (name, ok, evidence) => results.push({name, ok, evidence});
    const settle = () => new Promise(r => setTimeout(r, 180));
    await app.plugins.disablePlugin('ai-commit');
    await app.plugins.enablePlugin('ai-commit');
    const p = app.plugins.plugins['ai-commit'];
    app.workspace.getLeavesOfType('git-view').forEach(l => l.detach());
    app.commands.executeCommandById('obsidian-git:open-git-view');
    await settle();
    let t = app.workspace.getLeavesOfType('git-view')[0].view.containerEl.querySelector('textarea');
    const type = async value => {t.value=value;t.dispatchEvent(new Event('input',{bubbles:true}));await settle();};
    await type(Array(30).fill('Regression fixture line').join('\n'));
    check('limit before first generation', t.clientHeight <= 240 && t.scrollHeight > t.clientHeight, {height:t.clientHeight,scroll:t.scrollHeight});
    // Real requestUrl transport, synthetic local responses only.
    const fixture = {models:[{name:'model-a'}],delay:0,message:Array(30).fill('Updated fixture.').join('\n'),requests:[]};
    const server = require('http').createServer((req,res)=>{
        let body='';req.on('data',d=>body+=d);req.on('end',()=>{
            fixture.requests.push({url:req.url,headers:req.headers,body:body?JSON.parse(body):null});
            const payload=req.url==='/api/tags'?{models:fixture.models}:{message:{content:fixture.message}};
            setTimeout(()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(payload));},fixture.delay);
        });
    });
    await new Promise(r=>server.listen(19223,'127.0.0.1',r));
    try {
        Object.assign(p.settings,{provider:'ollama',ollamaUrl:'http://127.0.0.1:19223',ollamaModel:'model-a',apiKey:'fixture-secret',timeout:1000});
        await p.generateAndFill();await settle();
        check('generated message scrolls',t.clientHeight<=240 && t.scrollHeight>t.clientHeight,{height:t.clientHeight,scroll:t.scrollHeight});
        check('Ollama excludes DeepSeek key',!fixture.requests.at(-1).headers.authorization,fixture.requests.at(-1).url);
        await type('Short');
        check('shrink after replacing long text',t.clientHeight<100,t.clientHeight);
        await type(Array(30).fill('Long').join('\n'));
        t.parentElement.querySelector('.git-commit-msg-clear-button').click();await settle();
        check('shrink after native clear',t.value==='' && t.clientHeight<100,{height:t.clientHeight,value:t.value});
        await app.plugins.disablePlugin('ai-commit');await settle();
        const before=t.getAttribute('style');await type('Changed while disabled');
        check('unload releases textarea',!t.dataset.aiCommitAutosize && !t.classList.contains('ai-commit-autosize') && !t.style.getPropertyValue('--ai-commit-textarea-height') && t.getAttribute('style')===before,{style:t.getAttribute('style'),dataset:{...t.dataset}});
        await app.plugins.enablePlugin('ai-commit');await settle();
        const current=app.plugins.plugins['ai-commit'];Object.assign(current.settings,{provider:'ollama',ollamaUrl:'http://127.0.0.1:19223',ollamaModel:'model-a'});
        for(let i=0;i<3;i++){app.workspace.getLeavesOfType('git-view').forEach(l=>l.detach());app.commands.executeCommandById('obsidian-git:open-git-view');await settle();}
        t=app.workspace.getLeavesOfType('git-view')[0].view.containerEl.querySelector('textarea');await type(Array(30).fill('Line').join('\n'));
        check('new view is sized',t.clientHeight<=240,t.clientHeight);
        check('one live button',document.querySelectorAll('#ai-commit-btn').length===1,document.querySelectorAll('#ai-commit-btn').length);
        app.setting.open();app.setting.openTabById('ai-commit');await settle();
        const settingsDocument=app.setting.activeTab.containerEl.ownerDocument;
        const row=name=>[...settingsDocument.querySelectorAll('.setting-item')].find(e=>e.querySelector('.setting-item-name')?.textContent===name);
        const modelRow=()=>row('Ollama model');
        const refresh=()=>modelRow().querySelector('.extra-setting-button').click();
        refresh();await settle();
        check('manual model remains after detection',!!modelRow().querySelector('input'),modelRow().innerText);
        fixture.models=[];refresh();await settle();
        check('empty detection clears suggestions',![...settingsDocument.querySelectorAll('.menu-item-title')].some(o=>o.textContent==='model-a'),modelRow().innerHTML);
        fixture.models=[{name:'old-server-model'}];fixture.delay=400;refresh();
        const url=row('Ollama server URL').querySelector('input');url.value='http://127.0.0.1:19224';url.dispatchEvent(new Event('input',{bubbles:true}));
        await new Promise(r=>setTimeout(r,550));
        check('late response from old URL ignored',![...settingsDocument.querySelectorAll('.menu-item-title')].some(o=>o.textContent==='old-server-model'),modelRow().innerHTML);
        app.setting.close();
    } finally {server.close();}
    return results;
}
ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`(${probe.toString()})()`,awaitPromise:true,returnByValue:true}}));
const response = await new Promise(r => ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id===1)r(m.result);}));
ws.close();
assert.ok(!response.exceptionDetails,JSON.stringify(response.exceptionDetails));
console.log(JSON.stringify(response.result.value,null,2));
assert.ok(response.result.value.every(r=>r.ok),'Obsidian regression checks failed');
