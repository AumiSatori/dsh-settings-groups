import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {resolve,dirname,join,extname,basename} from 'node:path'
import {fileURLToPath} from 'node:url'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),vendor=process.env.DSG_VENDOR||join(root,'node_modules')
const workspace=resolve(root,basename(dirname(root))==='.scratch'?'../..':'..'),output=process.env.DSG_FIRST_FRAME_OUTPUT||resolve(workspace,'.scratch/settings-first-frame-qa')
await mkdir(output,{recursive:true})
const {chromium}=createRequire(join(vendor,'noop.js'))('playwright')
const html=(await readFile(join(root,'test/harness.html'),'utf8')).replace('let mounted = true;','let mounted = false;').replace('</style>',`#toolbar{position:relative;z-index:9999}#root{position:fixed;inset:0;display:grid;place-items:center;pointer-events:none}#root>[role=dialog]{position:relative;pointer-events:auto}body[data-test-dark]{background:#181a20;color:#eee}body[data-test-dark] [role=dialog]{background:#24262d;color:#eee}body[data-test-dark] nav{background:#202229;color:#eee}</style>`)
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost')
 if(url.pathname==='/api/dsh-settings-groups/config'){res.setHeader('content-type','application/json');res.end('{"ok":true,"config":null}');return}
 if(url.pathname==='/'){res.setHeader('content-type','text/html; charset=utf-8');res.end(html);return}
 const file=url.pathname==='/client.js'?(process.env.DSG_FIRST_FRAME_CLIENT||join(root,'client.js')):url.pathname.startsWith('/vendor/')?join(vendor,url.pathname.slice(8)):null
 try{if(!file)throw Error('not found');res.setHeader('content-type',extname(file)==='.js'?'text/javascript':'text/plain');res.end(await readFile(file))}catch{res.writeHead(404).end()}
})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
const url=`http://127.0.0.1:${server.address().port}/`,browser=await chromium.launch({headless:true,channel:process.env.DSG_BROWSER_CHANNEL||'chrome'}),page=await browser.newPage({viewport:{width:1540,height:1080}}),errors=[]
page.on('pageerror',error=>errors.push(error.message))
await page.addInitScript(()=>{
 window.__frameRuns=[];window.__delayZeroTimers=true
 const nativeTimeout=window.setTimeout.bind(window)
 // Reproduce a busy event loop: a timer is allowed to follow the first paint.
 window.setTimeout=(callback,delay,...args)=>nativeTimeout(callback,window.__delayZeroTimers&&Number(delay||0)===0?110:delay,...args)
 const seen=new WeakSet()
 new MutationObserver(()=>{
  const panel=document.querySelector('[data-shortcut-modal=settings]');if(!panel||seen.has(panel))return;seen.add(panel)
  const run=[];window.__frameRuns.push(run);const start=performance.now()
  const frame=()=>{
   if(!panel.isConnected)return
   const cs=getComputedStyle(panel),box=panel.getBoundingClientRect(),nav=panel.querySelector(':scope > nav')
   run.push({time:performance.now()-start,w:panel.offsetWidth,h:panel.offsetHeight,x:box.x,y:box.y,renderedW:box.width,renderedH:box.height,navW:parseFloat(nav?.style.width)||null,transform:cs.transform,opacity:Number(cs.opacity),scale:cs.scale,decorated:panel.dataset.dshPtweak==='1'})
   if(run.at(-1).time<340)requestAnimationFrame(frame)
  };requestAnimationFrame(frame)
 }).observe(document,{subtree:true,childList:true})
})
let passed=0
const key='dsh.settingsPanelTweak.v1',panel=()=>page.locator('[data-shortcut-modal=settings]')
async function check(name,run){await run();passed++;console.log('PASS '+name)}
async function close(){if(await panel().count()){await page.locator('#btn-open').click();await panel().waitFor({state:'detached'})}}
async function opening(preference){
 await close();await page.evaluate(({key,preference})=>{localStorage.setItem(key,JSON.stringify(preference));window.__frameRuns=[]},{key,preference})
 await page.locator('#btn-open').click()
 try{await page.waitForFunction(()=>window.__frameRuns.at(-1)?.at(-1)?.time>340,{},{timeout:3000})}
 catch(error){console.log('OPENING DIAGNOSTIC '+JSON.stringify(await page.evaluate(()=>({runs:window.__frameRuns.map(run=>({count:run.length,first:run[0],last:run.at(-1)})),panel:document.querySelector('[data-shortcut-modal=settings]')?.outerHTML.slice(0,350),error:window.__APPLY_ERROR__}))));throw error}
 return page.evaluate(()=>window.__frameRuns.at(-1))
}
function stable(frames,w,h,nav){
 assert.ok(frames.length>=5)
 for(const frame of frames){assert.equal(frame.w,w,JSON.stringify(frames));assert.equal(frame.h,h,JSON.stringify(frames));assert.equal(frame.decorated,true);if(nav!==undefined)assert.equal(frame.navW,nav)}
 const positions=frames.map(frame=>frame.transform);assert.equal(new Set(positions).size,1,'Position remains stable while the existing entry scale animates')
}
try{
 await page.goto(url);await page.waitForFunction(()=>window.__APPLIED__)
 await check('remembered width height sidebar and position apply before every visible opening frame even when timers are delayed',async()=>{
  const preference={panelW:1280,panelH:860,navW:260,dx:40,dy:-18},frames=await opening(preference)
  stable(frames,1280,860,260);assert.ok(frames.some(frame=>frame.opacity>0&&frame.opacity<1),'The entry fade still has intermediate frames');assert.ok(frames.some(frame=>parseFloat(frame.scale)<1),'Existing scale entry is preserved')
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),JSON.stringify(preference))
  await writeFile(join(output,'remembered-opening-frames.json'),JSON.stringify(frames,null,2))
  await panel().screenshot({path:join(output,'remembered-size-light.png')})
 })
 await check('a fresh preference uses the responsive default from the first frame and reopening retains a resized value',async()=>{
  stable(await opening({}),1080,920)
  stable(await opening({panelW:720,panelH:560,navW:180,dx:-80,dy:28}),720,560,180)
  stable(await opening({panelW:720,panelH:560,navW:180,dx:-80,dy:28}),720,560,180)
 })
 await check('oversized memories clamp before paint on narrow windows without overwriting desktop preferences',async()=>{
  await close();await page.setViewportSize({width:520,height:700});await page.evaluate(()=>document.body.setAttribute('data-test-dark',''))
  const preference={panelW:1280,panelH:860,navW:400,dx:600,dy:-300},frames=await opening(preference)
  stable(frames,504,684)
  for(const frame of frames){assert.ok(frame.x>=7.5&&frame.y>=7.5);assert.ok(frame.x+frame.renderedW<=512.5);assert.ok(frame.y+frame.renderedH<=692.5)}
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),JSON.stringify(preference))
  await panel().screenshot({path:join(output,'narrow-dark.png')})
 })
 await check('reduced motion and the plugin animation-off mode still restore geometry before paint',async()=>{
  await close();await page.setViewportSize({width:1540,height:1080});await page.emulateMedia({reducedMotion:'reduce'})
  const frames=await opening({panelW:1160,panelH:800});stable(frames,1160,800);assert.ok(frames.every(frame=>frame.opacity===1&&['none','1'].includes(frame.scale)))
  await page.emulateMedia({reducedMotion:'no-preference'})
  await page.getByRole('switch',{name:'启用动效',exact:true}).click()
  assert.equal(await page.locator('html').getAttribute('data-dsg-motion'),'off')
  const off=await opening({panelW:1000,panelH:760});stable(off,1000,760);assert.ok(off.every(frame=>frame.opacity===1))
 })
 await check('rapid close reopen keeps a single decorated panel and unloading cannot resurrect a queued mount',async()=>{
  await page.evaluate(()=>{document.getElementById('btn-open').click();document.getElementById('btn-open').click()});await page.waitForTimeout(160)
  assert.equal(await panel().count(),1);assert.equal(await panel().getAttribute('data-dsh-ptweak'),'1');assert.equal(await page.locator('[data-dsg-ghost]').count(),0)
  const result=await page.evaluate(async()=>{
   const panel=document.querySelector('[data-shortcut-modal=settings]');panel.appendChild(document.createElement('span'))
   await Promise.resolve();for(const cleanup of window.__effectCleanups)if(typeof cleanup==='function')cleanup()
   await Promise.resolve();await Promise.resolve();return{decorated:panel.hasAttribute('data-dsh-ptweak'),handles:panel.querySelectorAll('.dsh-ptweak-rz,.dsh-ptweak-split').length,width:panel.style.width}
  })
  assert.deepEqual(result,{decorated:false,handles:0,width:''})
 })
 assert.deepEqual(errors,[])
 await writeFile(join(output,'verification.json'),JSON.stringify({passed,errors},null,2));console.log(`${passed} first-frame browser groups passed`)
}finally{await browser.close();await new Promise(done=>server.close(done))}
