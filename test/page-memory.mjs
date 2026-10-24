import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {readFile} from 'node:fs/promises'
import {resolve,dirname,join,extname} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),vendor=process.env.DSG_VENDOR||join(root,'node_modules')
const {chromium}=createRequire(join(vendor,'noop.js'))('playwright')
let disk=null,delay=0
const html=(await readFile(join(root,'test/harness.html'),'utf8'))
  .replace("const [activeId, setActiveId] = React.useState('general');",`const activeId = React.useSyncExternalStore(window.__shell.subscribe,window.__shell.getSnapshot).activeId || 'account'; const setActiveId = window.__shell.actions.select;`)
  .replace('let mounted = true;',`let mounted = false;`)
  .replace('render();\n\ndocument.getElementById("btn-rerender")',`window.__shellListeners=new Set();
window.__shellSnapshot={open:false,activeId:undefined};
window.__shell={
  subscribe(fn){__shellListeners.add(fn);return()=>__shellListeners.delete(fn)},
  getSnapshot(){return __shellSnapshot},
  actions:{
    open(){__shellSnapshot={...__shellSnapshot,open:true};mounted=true;window.__root?.unmount();render();window.__openCalls=(window.__openCalls||0)+1},
    close(){__shellSnapshot={open:false,activeId:undefined};mounted=false;window.__root?.unmount();render()},
    select(id){__shellSnapshot={...__shellSnapshot,activeId:id};for(const fn of __shellListeners)fn()},
    openSection(id){__shellSnapshot={open:true,activeId:id};mounted=true;window.__root?.unmount();render()},
  },
};
window.__nativeShellActions={...__shell.actions};
// Native SlotService keeps store on the entry; options contains only row metadata.
window.__ledger.push({name:'sidebar.settings',options:{},store:{create:()=>window.__shell}});
render();

document.getElementById("btn-rerender")`)
  .replace(`mounted = !mounted;\n\twindow.__root.unmount();\n\trender();`,`if(mounted)__shell.actions.close();else __shell.actions.open();`)
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost')
  if(url.pathname==='/api/dsh-settings-groups/config'){
    res.setHeader('content-type','application/json')
    if(req.method==='GET'){if(delay)await new Promise(done=>setTimeout(done,delay));res.end(JSON.stringify({ok:true,config:disk}));return}
    let body='';for await(const chunk of req)body+=chunk;disk=JSON.parse(body);res.end('{"ok":true}');return
  }
  if(url.pathname==='/'){res.setHeader('content-type','text/html; charset=utf-8');res.end(html);return}
  const file=url.pathname==='/client.js'?join(root,'client.js'):url.pathname.startsWith('/vendor/')?join(vendor,url.pathname.slice(8)):null
  try{if(!file)throw Error('not found');res.setHeader('content-type',extname(file)==='.js'?'text/javascript':'text/plain');res.end(await readFile(file))}catch{res.writeHead(404).end()}
})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
const port=server.address().port,browser=await chromium.launch({headless:true,channel:process.env.DSG_BROWSER_CHANNEL||'chrome'})
const page=await browser.newPage({viewport:{width:1100,height:960}}),errors=[]
page.on('pageerror',error=>errors.push(error.message))
const url=`http://127.0.0.1:${port}/`
const active=()=>page.locator('#navlist > button[aria-current=true]').getAttribute('data-section')
const open=()=>page.locator('#btn-open').click()
const select=async id=>{await page.locator(`nav [data-section="${id}"]`).click();await page.waitForFunction(id=>window.__shellSnapshot.activeId===id,id)}
const waitSave=()=>page.waitForTimeout(320)
let passed=0
async function check(name,fn){await fn();passed++;console.log('PASS '+name)}
try{
  await page.goto(url);await page.waitForFunction(()=>window.__APPLIED__)
  await check('first open preserves the host default; closing and reopening restore the exact selected page',async()=>{
    await open();assert.equal(await active(),'account')
    await select('dsh-read-aloud');await open();await open();assert.equal(await active(),'dsh-read-aloud')
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('dsh.settingsGroups.v1')).lastSection),'dsh-read-aloud')
    await waitSave();assert.equal(disk.lastSection,'dsh-read-aloud')
  })
  await check('normal navigation and rapid close retain the last page, including the management page',async()=>{
    await select('models');await select('settings-groups-manage');await open();await open();assert.equal(await active(),'settings-groups-manage')
  })
  await check('reload, an empty browser cache and a fresh browser context restore the host-saved page',async()=>{
    await select('dsh-remotion');await open();await waitSave();assert.equal(disk.lastSection,'dsh-remotion')
    await page.reload();await page.waitForTimeout(150);await open();assert.equal(await active(),'dsh-remotion')
    await page.evaluate(()=>localStorage.clear());await page.reload();await page.waitForTimeout(200);await open();assert.equal(await active(),'dsh-remotion')
    const fresh=await browser.newPage();await fresh.goto(url);await fresh.waitForTimeout(250);await fresh.locator('#btn-open').click();assert.equal(await fresh.locator('#navlist > button[aria-current=true]').getAttribute('data-section'),'dsh-remotion');await fresh.close()
  })
  await check('explicit section links take precedence even when targeting the ordinary first page',async()=>{
    await open();await page.evaluate(()=>__shell.actions.openSection('account'));assert.equal(await active(),'account');await open();await open();assert.equal(await active(),'account')
  })
  await check('hidden or removed pages fall back without opening an invalid or invisible section',async()=>{
    await select('dsh-remotion');await open();await waitSave()
    disk={...disk,updatedAt:Date.now()+1000,hidden:['dsh-remotion']};await page.evaluate(()=>localStorage.clear());await page.reload();await page.waitForTimeout(180);await open();assert.equal(await active(),'account')
    await select('models');await open();await page.evaluate(()=>__removeSection('models'));await open();assert.equal(await active(),'account')
  })
  await check('a generic open before disk hydration recovers the remembered page without overwriting other saved preferences',async()=>{
    await page.evaluate(()=>localStorage.clear());disk={...disk,updatedAt:Date.now()+2000,lastSection:'dsh-read-aloud',animations:false};delay=450
    await page.reload();await page.waitForFunction(()=>window.__APPLIED__);await open();await page.waitForTimeout(650);assert.equal(await active(),'dsh-read-aloud');assert.equal(disk.animations,false);delay=0
  })
  await check('grouping can be disabled while page memory still works; direct user selection wins over delayed hydration',async()=>{
    await select('settings-groups-manage');await page.getByRole('switch',{name:'启用分组',exact:true}).click();await select('plugins');await open();await open();assert.equal(await active(),'plugins')
    await open();await waitSave();await page.evaluate(()=>localStorage.clear());disk={...disk,updatedAt:Date.now()+3000,lastSection:'dsh-read-aloud'};delay=450
    await page.reload();await page.waitForFunction(()=>window.__APPLIED__);await open();await select('models');await page.waitForTimeout(700);assert.equal(await active(),'models');assert.equal(disk.lastSection,'models');delay=0
  })
  await check('unloading restores the original host actions and removes page tracking',async()=>{
    await page.evaluate(()=>{for(const cleanup of [...__effectCleanups].reverse())if(typeof cleanup==='function')cleanup()})
    assert.equal(await page.evaluate(()=>Object.keys(__nativeShellActions).every(key=>__shell.actions[key]===__nativeShellActions[key])),true)
  })
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed}))
}finally{await browser.close();server.close()}
