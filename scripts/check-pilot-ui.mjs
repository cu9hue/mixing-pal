import assert from 'node:assert/strict';
import { webkit } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
const artifacts = `.superpowers/proxy/ui-${Date.now()}`;
mkdirSync(artifacts, {recursive:true});
console.log('Browser artifacts:', artifacts);
const log = openSync(`${artifacts}/vite.txt`, 'w');
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','1423','--strictPort'], {stdio:['ignore',log,log]});
server.unref();
process.on('exit', ()=>server.kill());
let ready=false;
for (let i=0; i<100; i++) {
  if (server.exitCode !== null) throw new Error(`Browser test server could not start; see ${artifacts}/vite.txt`);
  try { ready=(await fetch('http://127.0.0.1:1423', {signal:AbortSignal.timeout(500)})).ok; } catch {}
  if(ready) break;
  await new Promise(resolve=>setTimeout(resolve,100));
}
if (!ready) throw new Error('Browser test server did not become ready.');
const browser = await webkit.launch({headless:true});
const page = await browser.newPage({viewport:{width:380,height:480}});
const errors=[]; page.on('pageerror', e=>errors.push(e.message));
await page.exposeFunction('resizeNative', ({width,height})=>page.setViewportSize({width,height}));
await page.route(/\/src\/main\.tsx(?:\?t=\d+)?$/, route=>route.fulfill({contentType:'application/javascript',body:`
import { mockIPC, mockWindows } from '/node_modules/@tauri-apps/api/mocks.js';
import { emit } from '/node_modules/@tauri-apps/api/event.js';
localStorage.setItem('copilot.setupDone','1'); localStorage.setItem('copilot.goal','Finish this arrangement');
if (location.search.includes('fresh')) { localStorage.removeItem('copilot.setupDone'); localStorage.removeItem('copilot.goal'); }
window.emitFixture=emit; window.saved=[]; window.requests=[]; window.shared=[];
window.account={access:'signed_out',capture:false};
const active={id:'producer',email:'invited@example.com',access:'active',capture:false,consent_epoch:0,remaining_micro_usd:5000000,period_end:Date.now()+86400000};
const access=new URLSearchParams(location.search).get('access');
if(access)window.account={...active,access,capture:true};
if(location.search.includes('held'))window.account={...active,can_ask:false,reserved_micro_usd:319489};
const snapshot=[{addr:'/live/mixingpal/get/version',args:[12]},{addr:'/live/song/get/tempo',args:[128]},{addr:'/live/track/get/name',args:[0,'Drums']}];
mockWindows('main'); mockIPC(async (cmd,args)=>{
window.requests.push({cmd,args});
if(cmd==='snapshot')return snapshot;
if(cmd==='account_status')return {...window.account};
if(cmd==='account_send_code')return null;
if(cmd==='account_sign_in')return window.account={...active,access:'invitation_required'};
if(cmd==='account_redeem')return window.account={...active};
if(cmd==='account_consent')return window.account={...window.account,capture:args.enabled,consent_epoch:window.account.consent_epoch+1};
if(cmd==='account_sign_out'){window.account={access:'signed_out',capture:false};return;}
if(cmd==='connector_status')return {folder:'MixingPal',installed:true};
if(cmd==='live_is_running')return true;
if(cmd==='connection_status')return {status:'bound'};
if(cmd==='get_settings')return {base_url:'',model:'',has_key:false};
if(cmd==='set_window_mode'){window.geometry=args;return window.resizeNative(args);}
if(cmd==='load_thread')return {saved_at:Math.floor(Date.now()/1000),note:[],next_bullet:0,exchanges:[{turnId:args.setId==='B'?'22222222-2222-4222-8222-222222222222':'11111111-1111-4111-8111-111111111111',question:'Question for '+args.setId,answer:'Answer for '+args.setId,error:null}]};
if(cmd==='save_thread'){window.saved.push(args);return;}
if(cmd==='turn_event')return;
if(cmd==='model_complete'){const account={...window.account};return new Promise(resolve=>window.finishModel=()=>resolve({text:'A complete answer.',tool_calls:[],account}));}
if(cmd==='turn_feedback'){window.shared.push(args);return new Promise(resolve=>window.finishFeedback=()=>resolve({saved:true}));}
throw new Error('Unexpected native call: '+cmd);
},{shouldMockEvents:true});
setInterval(()=>emit('live://deltas',snapshot),1000);
await import('/src/main.tsx?proxy-fixture');
`}));
try {
await page.goto('http://127.0.0.1:1423');
await page.getByLabel('Email',{exact:true}).fill('invited@example.com');
await page.getByRole('button',{name:'Send a code',exact:true}).click();
await page.getByLabel('Six-digit sign-in code').fill('123456');
await page.getByRole('button',{name:'Sign in',exact:true}).click();
await page.getByLabel('Invitation code').fill('example-invite-code');
await page.getByRole('button',{name:'Join the free pilot'}).click();
await page.getByLabel('Ask about the set',{exact:true}).waitFor();
assert.equal(await page.getByLabel('Ask about the set',{exact:true}).isEnabled(),true);
await page.getByLabel('Ask about the set',{exact:true}).fill('Test consent ordering');
await page.getByLabel('Ask about the set',{exact:true}).press('Enter');
await page.waitForFunction(()=>!!window.finishModel);
await page.evaluate(()=>window.emitFixture('menu://settings'));
await page.getByLabel('Share advice turns to help improve Mixing Pal').check();
await page.evaluate(()=>window.finishModel());
await page.waitForTimeout(100);
assert.equal(await page.getByLabel('Share advice turns to help improve Mixing Pal').isChecked(),true);
await page.screenshot({path:`${artifacts}/settings.png`});
await page.getByRole('button',{name:'Done',exact:true}).click();
async function set(id){await page.evaluate(id=>window.emitFixture('live://deltas',[{addr:'/live/mixingpal/get/set_identity',args:[id,'Set '+id,'/fixture/'+id+'.als']}]),id); await page.getByText('Question for '+id,{exact:true}).waitFor();}
await set('A');
await page.getByRole('button',{name:'Tried this advice?',exact:true}).first().click();
await page.getByLabel('What did you hear?',{exact:true}).fill('A private report');
await page.getByLabel('Share this report with Mixing Pal for review').check();
await page.getByRole('button',{name:'Save outcome',exact:true}).click();
await page.waitForFunction(()=>!!window.finishFeedback);
await set('B');
await page.getByRole('button',{name:'Tried this advice?',exact:true}).click();
assert.equal(await page.getByLabel('What did you hear?',{exact:true}).inputValue(),'');
assert.equal(await page.getByLabel('Share this report with Mixing Pal for review').isChecked(),false);
await page.evaluate(()=>window.finishFeedback());
await page.waitForTimeout(100);
const saves=await page.evaluate(()=>window.saved);
assert.equal(saves.some(s=>s.setId==='A' && s.exchanges.some(x=>x.question==='Question for B')),false,'feedback response overwrote another set');
await page.screenshot({path:`${artifacts}/feedback.png`});
const geometry=await page.evaluate(()=>({height:innerHeight,scroll:document.documentElement.scrollHeight,width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
assert.equal(geometry.height,geometry.scroll);assert.equal(geometry.width,geometry.scrollWidth);
await page.goto('http://127.0.0.1:1423?fresh');
const setup=page.locator('.setup');
await setup.getByRole('button',{name:'Got it',exact:true}).click();
await setup.getByLabel('Email',{exact:true}).fill('invited@example.com');
await setup.getByRole('button',{name:'Send a code',exact:true}).click();
await setup.getByLabel('Six-digit sign-in code').fill('123456');
await setup.getByRole('button',{name:'Sign in',exact:true}).click();
await setup.getByLabel('Invitation code').fill('example-invite-code');
await setup.getByRole('button',{name:'Join the free pilot'}).click();
await setup.getByRole('button',{name:'Skip',exact:true}).click();
await page.locator('.card__main').waitFor({state:'visible'});
assert.equal(await page.getByLabel('Ask about the set',{exact:true}).isEnabled(),true);
assert.equal(await page.evaluate(()=>localStorage.getItem('copilot.setupDone')),'1');
for (const access of ['expired','revoked']) {
await page.goto('http://127.0.0.1:1423?access='+access);
await page.getByText('Your pilot access has ended. Contact Mixing Pal to continue.').waitFor();
const sharing=page.locator('.card__main').getByLabel('Share advice turns to help improve Mixing Pal');
assert.equal(await sharing.count(),1,access+' accounts must retain a withdrawal control');
assert.equal(await sharing.isChecked(),true);
await sharing.uncheck();
await page.waitForFunction(()=>window.account.capture===false);
assert.equal(await sharing.isEnabled(),false,access+' accounts must not enable sharing');
assert.equal(await page.getByLabel('Ask about the set',{exact:true}).isEnabled(),false);
}
await page.clock.install();
await page.goto('http://127.0.0.1:1423?held');
await page.getByText('We’re checking the last request’s usage before you can ask again.').waitFor();
assert.equal(await page.getByLabel('Ask about the set',{exact:true}).isEnabled(),false);
await page.evaluate(()=>{window.account={...window.account,can_ask:true,reserved_micro_usd:0};window.requests=[];});
await page.clock.fastForward(31000);
await page.waitForTimeout(100);
assert.equal(await page.getByLabel('Ask about the set',{exact:true}).isEnabled(),true,'reconciliation should restore asking');
const refreshed=await page.evaluate(()=>window.requests.filter(x=>x.cmd==='account_status').length);
assert.equal(refreshed,1);
await page.clock.fastForward(31000);
assert.equal(await page.evaluate(()=>window.requests.filter(x=>x.cmd==='account_status').length),refreshed,'stop polling once usage settles');
assert.deepEqual(errors,[]);
console.log('PASS held usage recovery, expired/revoked withdrawal, fresh setup and existing-install sign-in, stale consent response, feedback set switch, delayed feedback persistence, window geometry');
} catch(e){await page.screenshot({path:`${artifacts}/failure.png`});console.log(errors);throw e;} finally {await browser.close();server.kill();closeSync(log);}
