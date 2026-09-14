const fs=require('fs'), vm=require('vm'), assert=require('assert/strict');
const results=[];
function harness(file, data={}, respond=()=>({status:200,json:{choices:[{message:{content:'Fixed validation.'}}]}}), diff='diff --git a/a b/a\n+test'){
 const calls=[],notices=[],timers=[];
 class Plugin {async loadData(){return data}async saveData(d){this.saved=d}}
 class Notice {constructor(t){this.text=t;notices.push(this)}setMessage(t){this.text=t}hide(){this.hidden=true}}
 const api={Plugin,PluginSettingTab:class{},Notice,requestUrl:async p=>{calls.push(p);return respond(p)}};
 const context={module:{exports:{}},require:k=>k==='obsidian'?api:k==='child_process'?{execSync:()=>diff}:require(k),console:{error(){}},Error,DOMException,window:{setTimeout:(fn,ms)=>{const id=setTimeout(fn,ms>=10000?ms:0);if(ms>=10000)id.unref();timers.push(id);return id},activeDocument:{querySelector:()=>null}},HTMLElement:class{}};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),context);const p=new context.module.exports.default();p.app={vault:{adapter:{basePath:'/fixture'}},workspace:{getLeavesOfType:()=>[]}};
 return {p,calls,notices,close:()=>timers.forEach(clearTimeout)};
}
async function test(name,fn){await fn();results.push({name,result:'PASS'})}
(async()=>{
 const head=process.env.TEST_BUNDLE || require('path').join(__dirname,'../main.js');
 await test('Old settings retain DeepSeek key/model/prompt and gain provider defaults',async()=>{const h=harness(head,{apiKey:'fixture',model:'deepseek-v4-pro',customPrompt:'Russian'});await h.p.loadSettings();assert.equal(h.p.settings.provider,'deepseek');assert.equal(h.p.settings.ollamaModel,'llama3.1');assert.equal(h.p.settings.model,'deepseek-v4-pro');h.close()});
 const requests=[];
 for(const [label,file] of [['head',head]]) await test(`${label}: DeepSeek request succeeds`,async()=>{const h=harness(file,{apiKey:'fixture',model:'deepseek-v4-pro',customPrompt:'Russian'});await h.p.loadSettings();await h.p.generateAndFill();assert.equal(h.calls.length,1);assert.ok(h.notices.some(n=>n.text.includes('Done')));requests.push(JSON.stringify(h.calls[0]));h.close()});
 await test('DeepSeek request preserves URL, credentials, model and prompt',async()=>{const r=JSON.parse(requests[0]);assert.equal(r.url,'https://api.deepseek.com/chat/completions');assert.equal(r.headers.Authorization,'Bearer fixture');const b=JSON.parse(r.body);assert.equal(b.model,'deepseek-v4-pro');assert.ok(b.messages[0].content.endsWith('Russian'));assert.equal(b.max_tokens,500);});
 await test('Missing DeepSeek key makes no request',async()=>{const h=harness(head);await h.p.loadSettings();await h.p.generateAndFill();assert.equal(h.calls.length,0);assert.ok(h.notices.some(n=>n.text.includes('API key')));h.close()});
 await test('Empty staged diff makes no request',async()=>{const h=harness(head,{apiKey:'fixture'},undefined,'');await h.p.loadSettings();await h.p.generateAndFill();assert.equal(h.calls.length,0);h.close()});
 await test('Ollama request normalizes URL, uses native response, excludes key',async()=>{const h=harness(head,{provider:'ollama',apiKey:'fixture',ollamaUrl:' http://localhost:11434/// '},()=>({status:200,json:{message:{content:'Fixed validation.'}}}));await h.p.loadSettings();await h.p.generateAndFill();assert.equal(h.calls[0].url,'http://localhost:11434/api/chat');assert.equal(h.calls[0].headers.Authorization,undefined);assert.equal(JSON.parse(h.calls[0].body).stream,false);assert.ok(h.notices.some(n=>n.text.includes('Done')));h.close()});
 await test('Empty Ollama model makes no request',async()=>{const h=harness(head,{provider:'ollama',ollamaModel:'  '});await h.p.loadSettings();await h.p.generateAndFill();assert.equal(h.calls.length,0);h.close()});
 await test('Ollama tags support name/model fields and drop empty names',async()=>{const h=harness(head,{},()=>({status:200,json:{models:[{name:'a'},{model:'b'},{}]}}));await h.p.loadSettings();assert.equal(JSON.stringify(await h.p.fetchOllamaModels()),'["a","b"]');h.close()});
 await test('Ollama tags HTTP failure rejects',async()=>{const h=harness(head,{},()=>({status:500,text:'fixture failure'}));await h.p.loadSettings();await assert.rejects(h.p.fetchOllamaModels(),/500/);h.close()});
 await test('Code and diff responses are rejected rather than reported as success',async()=>{for(const content of ['-    display() {\n-        containerEl.empty();','```js\n  new Setting(containerEl)\n    .setName("Model");\n```']){const h=harness(head,{provider:'ollama'},()=>({status:200,json:{message:{content}}}));await h.p.loadSettings();await h.p.generateAndFill();assert.ok(!h.notices.some(n=>n.text.startsWith('Done')));assert.ok(h.notices.some(n=>n.text.includes('model returned code')));h.close()}});
 console.log(JSON.stringify(results,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
