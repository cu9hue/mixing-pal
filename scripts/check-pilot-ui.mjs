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
page.setDefaultTimeout(10_000);
const errors=[]; page.on('pageerror', e=>errors.push(e.message));
await page.exposeFunction('resizeNative', ({width,height})=>page.setViewportSize({width,height}));
await page.route(/\/src\/main\.tsx(?:\?t=\d+)?$/, route=>route.fulfill({contentType:'application/javascript',body:`
import { mockIPC, mockWindows } from '/node_modules/@tauri-apps/api/mocks.js';
import { emit } from '/node_modules/@tauri-apps/api/event.js';
localStorage.setItem('copilot.setupDone','1');
if (location.search.includes('fresh')) localStorage.removeItem('copilot.setupDone');
window.emitFixture=emit; window.saved=[]; window.savedThreads={}; window.requests=[]; window.shared=[];
window.account={access:'signed_out',capture:false};
window.reports=JSON.parse(sessionStorage.getItem('reports')||'[]');
window.experience=location.search.includes('fresh')?null:'finishes_tracks';
window.update={channel:'stable',phase:new URLSearchParams(location.search).get('update')||'idle',version:new URLSearchParams(location.search).has('update')?'99.0.0':undefined,notes:'A changelog that should not appear.'};
const active={id:'producer',email:'invited@example.com',access:'active',capture:false,consent_epoch:0,remaining_micro_usd:5000000,period_end:Date.now()+86400000};
const access=new URLSearchParams(location.search).get('access');
if(access)window.account={...active,access,capture:true};
if(location.search.includes('held'))window.account={...active,can_ask:false,reserved_micro_usd:319489};
if(location.search.includes('paused'))window.account={...active,can_ask:false,service_paused:true};
const disconnected=location.search.includes('disconnected');
const initialSet=location.search.includes('fresh')?'fresh-set':'default';
window.currentSet=initialSet;
window.switchSet=(id)=>{window.currentSet=id;return emit('live://deltas',[{addr:'/live/mixingpal/get/set_identity',args:[id,'Set '+id,'/fixture/'+id+'.als']}]);};
const snapshot=[{addr:'/live/mixingpal/get/version',args:[16]},{addr:'/live/mixingpal/get/set_identity',args:[initialSet,'Set '+initialSet,'/fixture/'+initialSet+'.als']},{addr:'/live/song/get/tempo',args:[128]},{addr:'/live/track/get/name',args:[0,'Drums']}];
mockWindows('main'); mockIPC(async (cmd,args)=>{
window.requests.push({cmd,args});
if(cmd==='snapshot')return disconnected?[]:snapshot;
if(cmd==='account_status')return {...window.account};
if(cmd==='account_send_code')return null;
if(cmd==='account_sign_in')return window.account={...active,access:'invitation_required'};
if(cmd==='account_redeem')return window.account={...active};
if(cmd==='account_consent')return window.account={...window.account,capture:args.enabled,consent_epoch:window.account.consent_epoch+1,sharing_chosen:true};
if(cmd==='account_sign_out'){window.account={access:'signed_out',capture:false};return;}
if(cmd==='connector_status')return {folder:'MixingPal',installed:true};
if(cmd==='live_is_running')return true;
if(cmd==='connection_status')return {status:'bound'};
if(cmd==='check_update')return window.update.phase==='delayed'?new Promise(resolve=>window.finishUpdate=()=>resolve({...window.update,phase:'available'})):{...window.update};
if(cmd==='download_update')return window.update={...window.update,phase:'ready'};
if(cmd==='set_update_channel')return window.update={channel:args.channel,phase:'idle'};
if(cmd==='get_settings')return {base_url:'',model:'',has_key:false};
if(cmd==='get_experience')return window.experience;
if(cmd==='set_experience'){window.experience=args.experience;return null;}
if(cmd==='set_window_mode'){window.geometry=args;return window.resizeNative(args);}
if(cmd==='load_thread'){
  if(window.savedThreads[args.setId])return window.savedThreads[args.setId];
  if(['C','D','fresh-set'].includes(args.setId))return null;
  if(args.setId==='R'){const at=Math.floor(Date.now()/1000)-2*86400,id=n=>'3333333'+n+'-3333-4333-8333-333333333333';return {saved_at:at,goal:'Make the drop hit harder',next_bullet:1,
    note:[{id:'b0',kind:'decided',text:'Keep the vocal dry until the second drop',at,hers:true}],
    exchanges:[{turnId:id(1),question:'Why does the drop feel weaker than the intro?',answer:'Answer for R one',error:null,move:'«Kick»: shorten the tail to 180 ms'},
      {turnId:id(2),question:'What is on the Pad chain?',answer:'Answer for R two',error:null,move:'«Pad»: sidechain to the kick'},
      {turnId:id(3),question:'What should I work on next to finish this track before the weekend?',answer:'Answer for R three',error:null,move:'«Bass»: cut 200 Hz'}],
    outcomes:[{turnId:id(1),move:'«Kick»: shorten the tail to 180 ms',outcome:'kept',heard:'tighter now',tracks:[],answer:'',at},
      {turnId:id(2),move:'«Pad»: sidechain to the kick',outcome:'undone',heard:'too pumpy',tracks:[],answer:'',at:at+1}]};}
  return {saved_at:Math.floor(Date.now()/1000),goal:args.setId==='default'?'Finish this arrangement':'Goal for '+args.setId,note:[],next_bullet:0,
    exchanges:args.setId==='default'?[]:[{turnId:args.setId==='B'?'22222222-2222-4222-8222-222222222222':'11111111-1111-4111-8111-111111111111',question:'Question for '+args.setId,answer:'Answer for '+args.setId,error:null,move:'«Drums», test move '+args.setId}],outcomes:[]};
}
if(cmd==='save_thread'){window.saved.push(args);window.savedThreads[args.setId]={saved_at:Math.floor(Date.now()/1000),goal:args.goal,note:args.note,next_bullet:args.nextBullet,exchanges:args.exchanges,outcomes:args.outcomes};return;}
if(cmd==='incident_snapshot')return {limitations:['Trace unavailable after restart.']};
if(cmd==='report_submit'){
 if(window.reportSubmitFails)throw {message:'Could not save the report on this laptop.'};
 const receipt={id:args.input.id,origin:args.input.origin,turn_id:args.input.exchange?.turnId??null,created_at:Date.now(),status:location.search.includes('queued')?'queued':'received'};
 window.reports.push(receipt);sessionStorage.setItem('reports',JSON.stringify(window.reports));return receipt;
}
if(cmd==='report_list')return window.reports;
if(cmd==='report_delete'){window.reports=window.reports.map(r=>r.id===args.id?{...r,status:'deleted'}:r);sessionStorage.setItem('reports',JSON.stringify(window.reports));return;}
if(cmd==='turn_event')return;
if(cmd==='model_complete'){const account={...window.account};return new Promise((resolve,reject)=>{window.failModel=()=>reject({code:'completion_interrupted',message:'The reply was interrupted. It has not been retried. You can ask again.'});window.finishModel=(text='A complete answer.')=>resolve({text,tool_calls:[],account});});}
if(cmd==='account_delete_shared')return;
if(cmd==='turn_feedback'){window.shared.push(args);return {saved:true};}
throw new Error('Unexpected native call: '+cmd);
},{shouldMockEvents:true});
setInterval(()=>{if(!disconnected)emit('live://deltas',snapshot.map(delta=>delta.addr==='/live/mixingpal/get/set_identity'?{...delta,args:[window.currentSet,'Set '+window.currentSet,'/fixture/'+window.currentSet+'.als']}:delta))},1000);
await import('/src/main.tsx?proxy-fixture');
`}));
try {
for (const phase of ['available','ready']) {
await page.goto('http://127.0.0.1:1423?access=active&update='+phase);
const notice=page.getByRole('dialog',{name:'Mixing Pal update'});
await notice.waitFor();
await page.getByLabel('Ask about the set',{exact:true}).waitFor();
await page.waitForTimeout(150);
assert.equal(await notice.getByRole('button',{name:'Not now',exact:true}).evaluate(button=>button===document.activeElement),true,'dismissal receives initial focus');
const popup=await notice.boundingBox();
const later=await notice.getByRole('button',{name:'Not now',exact:true}).boundingBox();
assert.ok(later.y+later.height<=popup.y+popup.height,'popup actions must be visible without scrolling');
await page.screenshot({path:`${artifacts}/update-${phase}.png`});
assert.equal(await notice.getByText('99.0.0',{exact:false}).count(),1);
assert.equal(await page.getByText('A changelog that should not appear.').count(),0);
await notice.getByRole('button',{name:'Not now',exact:true}).click();
assert.equal(await notice.count(),0);
const composer=page.getByLabel('Ask about the set',{exact:true});
await composer.fill('Keep my draft');
await page.evaluate(()=>window.emitFixture('menu://settings'));
const done=page.getByRole('button',{name:'Done',exact:true});
assert.equal(await page.getByText('A changelog that should not appear.').count(),0,'settings omits the changelog');
await done.waitFor();
for (const ceiling of [520,360]) {
await page.evaluate(ceiling=>document.documentElement.style.setProperty('--card-max-height',`${ceiling}px`),ceiling);
await page.waitForTimeout(100);
const before=await done.boundingBox();
assert.ok(before.y>=0&&before.y+before.height<=await page.evaluate(()=>innerHeight),'Done must be visible before scrolling');
await page.getByRole('button',{name:'Reinstall',exact:true}).scrollIntoViewIfNeeded();
const after=await done.boundingBox();
assert.equal(Math.round(after.y),Math.round(before.y),'Done must stay in place while settings scrolls');
await page.screenshot({path:`${artifacts}/settings-footer-${phase}-${ceiling}.png`});
}
await page.evaluate(()=>document.documentElement.style.setProperty('--card-max-height','520px'));
await page.getByRole('heading',{name:'App updates',exact:true}).scrollIntoViewIfNeeded();
// DESIGN.md: Settings controls share one neutral outline, so Check for updates reads as a button.
const outline=name=>page.getByRole('button',{name,exact:true}).evaluate(e=>getComputedStyle(e).borderTopColor);
assert.equal(await outline('Check for updates'),await outline('Reinstall'),'Check for updates has the Settings outline');
await page.screenshot({path:`${artifacts}/settings-update-${phase}.png`});
await done.click();
assert.equal(await composer.inputValue(),'Keep my draft','settings must preserve the chat draft');
assert.equal(await notice.count(),0,'dismissed updates must not reappear after settings');
assert.equal(await page.evaluate(()=>window.requests.some(x=>['download_update','install_update'].includes(x.cmd))),false,'dismissing must not download or restart');
}
await page.goto('http://127.0.0.1:1423?access=active&update=available');
await page.getByRole('dialog').waitFor();
await page.keyboard.press('Escape');
await page.getByLabel('Ask about the set',{exact:true}).waitFor();
assert.equal(await page.getByRole('dialog').count(),0,'Escape closes the update without collapsing the app');
await page.goto('http://127.0.0.1:1423?access=active&update=available');
await page.getByRole('button',{name:'Close update notification'}).click();
assert.equal(await page.getByRole('dialog').count(),0);
await page.evaluate(()=>window.emitFixture('menu://settings'));
await page.getByRole('button',{name:'Check for updates',exact:true}).click();
await page.getByRole('button',{name:'Done',exact:true}).click();
assert.equal(await page.getByRole('dialog').count(),0,'checking the same version must not undo dismissal');
await page.evaluate(()=>{window.update={...window.update,version:'99.0.1'};return window.emitFixture('menu://settings');});
await page.getByRole('button',{name:'Check for updates',exact:true}).click();
await page.getByText('Mixing Pal 99.0.1',{exact:false}).waitFor();
await page.getByRole('button',{name:'Done',exact:true}).click();
await page.getByRole('dialog').waitFor();
for (let i=0;i<5;i++) {
await page.keyboard.press('Tab');
assert.equal(await page.getByRole('dialog').evaluate(dialog=>dialog.contains(document.activeElement)),true,'keyboard focus stays in the popup');
}
await page.getByRole('dialog').getByRole('button',{name:'Review update',exact:true}).click();
await page.getByRole('button',{name:'Download update',exact:true}).click();
await page.getByRole('button',{name:'Install and restart Mixing Pal',exact:true}).waitFor();
await page.getByRole('button',{name:'Done',exact:true}).click();
assert.equal(await page.getByRole('dialog').count(),0,'reviewing acknowledges the notification');
await page.goto('http://127.0.0.1:1423?access=active&update=delayed');
const draft=page.getByLabel('Ask about the set',{exact:true});
await draft.fill('Keep typing after dismissal');
await page.evaluate(()=>window.finishUpdate());
await page.getByRole('dialog').waitFor();
await page.keyboard.press('Shift+Tab');
assert.equal(await page.getByRole('button',{name:'Review update',exact:true}).evaluate(button=>button===document.activeElement),true);
await page.keyboard.press('Escape');
assert.equal(await draft.inputValue(),'Keep typing after dismissal');
assert.equal(await draft.evaluate(input=>input===document.activeElement),true,'dismissal restores focus to the composer');
await page.goto('http://127.0.0.1:1423?access=active&update=delayed');
await page.getByLabel('Ask about the set',{exact:true}).waitFor();
await page.getByTitle('Collapse',{exact:true}).click();
await page.evaluate(()=>window.finishUpdate());
await page.waitForTimeout(100);
assert.equal(await page.getByRole('dialog').count(),0,'updates must not open over the collapsed pill');
await page.locator('.pill__body').click();
await page.getByRole('dialog').getByRole('button',{name:'Not now',exact:true}).click();
await page.goto('http://127.0.0.1:1423?fresh&update=available');
await page.locator('.setup').getByLabel('Email',{exact:true}).waitFor();
assert.equal(await page.getByRole('dialog').count(),0,'updates must not interrupt onboarding');
const spacing=await page.locator('.setup__bar').evaluate(bar=>({top:bar.firstElementChild.getBoundingClientRect().top,left:bar.firstElementChild.getBoundingClientRect().left,content:document.querySelector('.setup__label').getBoundingClientRect().left}));
assert.ok(spacing.top>=24,'onboarding progress needs space below the window edge');
assert.equal(spacing.left,spacing.content,'progress should align with the onboarding content');
await page.screenshot({path:`${artifacts}/onboarding-spacing.png`});
await page.goto('http://127.0.0.1:1423?access=active&disconnected');
await page.getByText('Not connected',{exact:true}).waitFor();
const disconnectedComposer=page.getByLabel('Ask about the set',{exact:true});
assert.equal(await disconnectedComposer.isVisible(),false,'the composer must stay hidden until Live reconnects');
await page.screenshot({path:`${artifacts}/disconnected.png`});
await page.goto('http://127.0.0.1:1423?access=active');
await page.getByLabel('Ask about the set',{exact:true}).waitFor();
assert.equal(await page.locator('.setup').count(),0,'a returning session opens in the card');
await page.getByRole('button',{name:'Finish this arrangement',exact:false}).waitFor();
await page.screenshot({path:`${artifacts}/session-goal.png`});
for (const ceiling of [520, 360]) {
await page.evaluate(ceiling=>document.documentElement.style.setProperty('--card-max-height',`${ceiling}px`),ceiling);
await page.getByLabel('Ask about the set',{exact:true}).fill('Show a long answer');
await page.getByLabel('Ask about the set',{exact:true}).press('Enter');
await page.waitForFunction(()=>!!window.finishModel);
await page.evaluate(()=>{window.finishModel('A paragraph of advice that wraps across several lines in this narrow window.\n\n'.repeat(30));window.finishModel=null;});
await page.locator('.card__answer').last().waitFor();
await page.waitForTimeout(150);
await page.screenshot({path:`${artifacts}/long-answer-${ceiling}.png`});
const layout=await page.evaluate(()=>{
  const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {top:r.top,bottom:r.bottom};};
  const body=document.querySelector('.card__body');
  return {header:rect('.card__header'),goal:rect('.set-row'),footer:rect('.card__footer'),
    height:innerHeight,bodyHeight:body.clientHeight,bodyScrollHeight:body.scrollHeight,cardScroll:document.querySelector('.card').scrollTop};
});
assert.ok(layout.header.top>=0&&layout.header.bottom<=layout.height,'the logo must stay inside the window after an answer');
assert.ok(layout.goal.top>=0&&layout.goal.bottom<=layout.height,'the goal must stay inside the window after an answer');
assert.ok(layout.footer.top>=0&&layout.footer.bottom<=layout.height,'the composer must stay inside the window after an answer');
assert.ok(layout.bodyHeight>0&&layout.bodyScrollHeight>layout.bodyHeight,'long answers must scroll inside the chat body');
assert.equal(layout.cardScroll,0,'autoscroll must not scroll the outer card');
await page.locator('.card__body').evaluate(body=>body.scrollTop=0);
await page.locator('.card__body').hover();
await page.mouse.wheel(0,200);
await page.waitForFunction(()=>document.querySelector('.card__body').scrollTop>0);
await page.goto('http://127.0.0.1:1423?access=active');
await page.getByLabel('Ask about the set',{exact:true}).waitFor();
}
async function openSet(id){await page.evaluate(id=>window.switchSet(id),id);}
// After a break the recap stands in for the earlier answers, and the check-in still asks about the newest move.
await openSet('R');
const lastTime=page.getByRole('region',{name:'Last time'});
await lastTime.waitFor();
assert.equal(await page.getByText('Answer for R one',{exact:true}).count(),0,'the recap folds the earlier answers');
assert.deepEqual(await lastTime.evaluate(e=>{const c=getComputedStyle(e);return [c.backgroundColor,c.borderTopWidth];}),['rgba(0, 0, 0, 0)','0px'],'the recap is not a card inside the card');
assert.equal(await lastTime.getByText('cut 200 Hz',{exact:false}).count(),0,'the recap leaves the unrated newest move to the check-in');
await page.getByLabel('Ask about the set',{exact:true}).click();
await page.getByRole('region',{name:'How did the last move go?'}).waitFor();
await page.screenshot({path:`${artifacts}/recap.png`});
await page.getByRole('button',{name:'Show 3 earlier answers',exact:true}).click();
await page.getByText('Answer for R one',{exact:true}).waitFor();
await page.screenshot({path:`${artifacts}/recap-unfolded.png`});
await openSet('C');
await page.getByLabel('Goal (optional)',{exact:true}).waitFor();
const promptBottom=await page.getByRole('button',{name:'Start chatting',exact:true}).evaluate(button=>button.getBoundingClientRect().bottom);
assert.ok(promptBottom<=await page.evaluate(()=>innerHeight),'the set goal actions must fit the card when the prompt appears');
await page.screenshot({path:`${artifacts}/new-set-goal.png`});
assert.equal(await page.getByLabel('Ask about the set',{exact:true}).isVisible(),false,'a new set asks for its goal first');
assert.equal(await page.getByRole('button',{name:'Skip',exact:true}).count(),0,'optional goal has one primary action');
await page.getByLabel('Goal (optional)',{exact:true}).fill('dark garage');
await page.getByRole('button',{name:'Start chatting',exact:true}).click();
await page.getByRole('button',{name:'dark garage',exact:false}).waitFor();
assert.equal(await page.evaluate(()=>window.savedThreads.C.goal),'dark garage');
await openSet('default');
await page.getByRole('button',{name:'Finish this arrangement',exact:false}).waitFor();
await openSet('C');
await page.getByRole('button',{name:'dark garage',exact:false}).waitFor();
assert.equal(await page.getByRole('button',{name:'Skip',exact:true}).count(),0,'reopening a set restores its goal');
await openSet('D');
await page.getByLabel('Goal (optional)',{exact:true}).waitFor();
await page.getByRole('button',{name:'Start chatting',exact:true}).click();
assert.equal(await page.evaluate(()=>window.savedThreads.D.goal),'','an empty goal is remembered for this set');
await openSet('C');
await page.getByRole('button',{name:'dark garage',exact:false}).waitFor();
await openSet('D');
await page.getByLabel('Ask about the set',{exact:true}).waitFor();
assert.equal(await page.getByRole('button',{name:'Start chatting',exact:true}).count(),0,'reopening a set with no goal goes straight to chat');
await openSet('default');
await page.getByRole('button',{name:'Finish this arrangement',exact:false}).waitFor();
await page.getByLabel('Ask about the set',{exact:true}).waitFor();
await page.goto('http://127.0.0.1:1423');
await page.getByLabel('Email',{exact:true}).waitFor();
await page.screenshot({path:`${artifacts}/sign-in.png`});
await page.getByLabel('Email',{exact:true}).fill('invited@example.com');
await page.getByRole('button',{name:'Continue',exact:true}).click();
const signInButton=page.getByRole('button',{name:'Sign in',exact:true});
const resendButton=page.getByRole('button',{name:'Use another email or resend',exact:true});
const [signInBox,resendBox]=await Promise.all([signInButton.boundingBox(),resendButton.boundingBox()]);
assert.ok(signInBox&&resendBox,'sign-in actions should be visible');
assert.equal(Math.round(signInBox.width),Math.round(resendBox.width),'sign-in actions should share a width');
await page.screenshot({path:`${artifacts}/sign-in-code.png`});
await page.getByLabel('Six-digit sign-in code').fill('123456');
await page.getByRole('button',{name:'Sign in',exact:true}).click();
await page.getByLabel('Invitation code').fill('example-invite-code');
await page.getByRole('button',{name:'Join the free pilot'}).click();
await page.getByLabel('Ask about the set',{exact:true}).waitFor();
assert.equal(await page.getByLabel('Ask about the set',{exact:true}).isEnabled(),true);
await page.getByLabel('Ask about the set',{exact:true}).fill('Test consent ordering');
await page.getByLabel('Ask about the set',{exact:true}).press('Enter');
await page.waitForFunction(()=>!!window.finishModel);
assert.equal(await page.evaluate(()=>window.requests.find(x=>x.cmd==='model_complete').args.captureEpoch),null);
await page.evaluate(()=>window.emitFixture('menu://settings'));
assert.equal(await page.getByLabel('I finish tracks').isChecked(),true,'settings shows the stored level');
await page.getByRole('radiogroup',{name:'How you work in Live'}).scrollIntoViewIfNeeded();
await page.screenshot({path:`${artifacts}/settings-answers.png`});
await page.getByLabel('Share advice and outcomes to help improve Mixing Pal').check();
const MOVE='A complete answer.\n```move\n«Drums», muddy kick: cut 2 dB at 300 Hz\n```';
await page.evaluate(text=>window.finishModel(text),MOVE);
await page.waitForTimeout(100);
assert.equal(await page.getByLabel('Share advice and outcomes to help improve Mixing Pal').isChecked(),true);
await page.screenshot({path:`${artifacts}/settings.png`});
await page.getByRole('button',{name:'Delete account…',exact:true}).click();
const keep=page.getByRole('button',{name:'Cancel',exact:true});
assert.equal(await keep.evaluate(e=>e===document.activeElement),true,'the delete confirmation starts on Cancel');
assert.equal(await page.getByRole('button',{name:'Delete my account',exact:true}).evaluate(e=>getComputedStyle(e).borderTopColor),'rgb(255, 47, 58)','the irreversible step is red (--error)');
await page.screenshot({path:`${artifacts}/settings-delete-account.png`});
await keep.click();
assert.equal(await page.getByRole('button',{name:'Delete my account',exact:true}).count(),0,'Cancel closes the confirmation');
assert.equal(await page.getByText('Optional. Save your questions, relevant set context, tool reads, raw answers and outcomes for human review for 30 days.').count(),0,'settings should not lead with the sharing explanation');
await page.getByRole('button',{name:'How sharing works',exact:true}).click();
await page.getByRole('tooltip').waitFor();
await page.screenshot({path:`${artifacts}/settings-sharing-tooltip.png`});
await page.getByRole('button',{name:'Done',exact:true}).click();
await page.getByLabel('Ask about the set',{exact:true}).fill('A new turn after opting in');
await page.getByLabel('Ask about the set',{exact:true}).press('Enter');
await page.waitForFunction(()=>window.requests.filter(x=>x.cmd==='model_complete').length===2);
assert.equal(await page.evaluate(()=>window.requests.filter(x=>x.cmd==='model_complete')[1].args.captureEpoch),1);
await page.evaluate(text=>window.finishModel(text),MOVE);
await page.getByText('A new turn after opting in',{exact:true}).waitFor();
const exchange=page.locator('.card__exchange').filter({hasText:'A new turn after opting in'});
await exchange.getByText('A complete answer.',{exact:true}).waitFor();
assert.equal(await exchange.locator('.move-result').count(),0,'nothing under a fresh answer');
assert.equal(await page.locator('.checkin').count(),0,'no check-in the moment the answer lands');
await page.screenshot({path:`${artifacts}/answer-closed.png`});
// The ⋯ follows the question's text on its line, and the footer always offers a report.
const menuBox=await exchange.getByRole('button',{name:'More actions',exact:true}).boundingBox();
const questionBox=await exchange.locator('.card__question').boundingBox();
assert.ok(menuBox.width>=24 && menuBox.height>=24,'the ⋯ is at least a 24px target');
assert.ok(menuBox.x>=questionBox.x+questionBox.width && menuBox.x-(questionBox.x+questionBox.width)<=8,'the ⋯ sits right after the question');
assert.ok(menuBox.y<questionBox.y+questionBox.height && menuBox.y+menuBox.height>questionBox.y,'the ⋯ is on the question line');
assert.equal(await page.locator('.card__footer').getByRole('button',{name:'Report a problem',exact:true}).isVisible(),true,'the footer offers a report');
assert.equal(await page.getByText('```move').count(),0,'the move block is not shown');
await page.getByLabel('Ask about the set',{exact:true}).click();
const checkin=page.getByRole('region',{name:'How did the last move go?'});
await checkin.waitFor();
// DESIGN.md: no nested cards. The check-in sits flat in the footer, like the access status line.
assert.deepEqual(await checkin.evaluate(e=>{const c=getComputedStyle(e);return [c.backgroundColor,c.borderTopWidth];}),['rgba(0, 0, 0, 0)','0px'],'the check-in is not a card inside the footer');
await page.screenshot({path:`${artifacts}/checkin.png`});
await checkin.getByRole('button',{name:'Undid it',exact:true}).click();
await page.waitForFunction(()=>window.shared.length===1);
await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='What did you hear?');
await page.screenshot({path:`${artifacts}/answer-open.png`});
const heard=checkin.getByLabel('What did you hear?');
await heard.fill('The kick lost its punch');
await heard.press('Enter');
await exchange.getByText('Undid it · “The kick lost its punch”',{exact:true}).waitFor();
assert.equal(await page.locator('.checkin').count(),0,'the check-in closes after the heard step');
const rated=await page.evaluate(()=>window.saved.filter(s=>s.setId==='default').at(-1).outcomes.at(-1));
assert.equal(rated.outcome,'undone');
assert.equal(rated.heard,'The kick lost its punch');
assert.equal(rated.move,'«Drums», muddy kick: cut 2 dB at 300 Hz');
await exchange.getByRole('button',{name:'More actions',exact:true}).click();
await page.getByRole('menuitem',{name:'Change how it went',exact:true}).click();
const kept=exchange.getByRole('button',{name:'Kept it',exact:true});
await kept.click();
// Undid, its heard text, then this change: three shares.
await page.waitForFunction(()=>window.shared.length===3);
await exchange.getByLabel('What did you hear?').press('Escape');
await exchange.getByText('Kept it',{exact:true}).waitFor();
await page.getByLabel('Ask about the set',{exact:true}).fill('A failed shared turn');
await page.getByLabel('Ask about the set',{exact:true}).press('Enter');
await page.waitForFunction(()=>window.requests.filter(x=>x.cmd==='model_complete').length===3);
await page.evaluate(()=>window.failModel());
const failed=page.locator('.card__exchange').filter({hasText:'A failed shared turn'});
await failed.getByText('The reply was interrupted. It has not been retried. You can ask again.',{exact:true}).waitFor();
assert.equal(await failed.getByRole('button',{name:'Report this',exact:true}).isVisible(),true,'a failed answer offers a report right under it');
await page.screenshot({path:`${artifacts}/failed-report.png`});
await failed.getByRole('button',{name:'More actions',exact:true}).click();
assert.equal(await page.getByRole('menuitem',{name:'Change how it went',exact:true}).count(),0,'a turn with no answer has nothing to rate');
await page.screenshot({path:`${artifacts}/answer-menu-open.png`});
await page.getByRole('menuitem',{name:'Report a problem',exact:true}).press('Escape');
await page.evaluate(()=>window.emitFixture('menu://settings'));
await page.getByRole('button',{name:'Delete shared advice…',exact:true}).click();
await page.getByRole('button',{name:'Delete shared advice',exact:true}).click();
await page.getByText('Deletion requested.',{exact:true}).waitFor();
assert.equal(await page.evaluate(()=>window.requests.filter(x=>x.cmd==='account_delete_shared').length),1);
assert.equal(await page.getByLabel('Share advice and outcomes to help improve Mixing Pal').isChecked(),true,'deleting shared advice keeps the sharing choice');
await page.getByRole('button',{name:'Done',exact:true}).click();
async function set(id){await page.evaluate(id=>window.switchSet(id),id); await page.getByText('Question for '+id,{exact:true}).waitFor();}
await set('A');
const sharedBefore=await page.evaluate(()=>window.shared.length);
await page.getByLabel('Ask about the set',{exact:true}).click();
await page.getByRole('region',{name:'How did the last move go?'}).getByRole('button',{name:'Kept it',exact:true}).click();
await page.waitForFunction(n=>window.shared.length===n+1,sharedBefore);
await set('B');
assert.equal(await page.evaluate(()=>window.savedThreads.A.outcomes.length),1,'the rating saved under set A');
assert.equal(await page.evaluate(()=>window.saved.some(s=>s.setId==='B'&&s.outcomes.length>0)),false,'a rating in A never lands in B');
await page.evaluate(()=>window.emitFixture('menu://settings'));
await page.getByLabel('Share advice and outcomes to help improve Mixing Pal').uncheck();
await page.getByRole('button',{name:'Done',exact:true}).click();
await page.getByLabel('Ask about the set',{exact:true}).click();
await page.getByRole('region',{name:'How did the last move go?'}).getByRole('button',{name:'Kept it',exact:true}).click();
await page.waitForTimeout(100);
assert.equal(await page.evaluate(()=>window.shared.length),sharedBefore+1,'sharing off keeps the rating local');
assert.equal(await page.evaluate(()=>window.savedThreads.B.outcomes.length),1,'a local rating is still saved');
await page.screenshot({path:`${artifacts}/feedback.png`});
const geometry=await page.evaluate(()=>({height:innerHeight,scroll:document.documentElement.scrollHeight,width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
assert.equal(geometry.height,geometry.scroll);assert.equal(geometry.width,geometry.scrollWidth);
await page.goto('http://127.0.0.1:1423?fresh');
const setup=page.locator('.setup');
await setup.getByLabel('Email',{exact:true}).waitFor();
await page.screenshot({path:`${artifacts}/fresh-sign-in.png`});
await setup.getByLabel('Email',{exact:true}).fill('invited@example.com');
await setup.getByRole('button',{name:'Continue',exact:true}).click();
await setup.getByLabel('Six-digit sign-in code').fill('123456');
await setup.getByRole('button',{name:'Sign in',exact:true}).click();
await setup.getByLabel('Invitation code').fill('example-invite-code');
await setup.getByRole('button',{name:'Join the free pilot'}).click();
await setup.getByText('Step 2 of 4',{exact:true}).waitFor();
await page.screenshot({path:`${artifacts}/fresh-sharing.png`});
await setup.getByRole('button',{name:/^Don't share/}).click();
assert.equal(await page.evaluate(()=>window.requests.filter(x=>x.cmd==='account_consent').at(-1).args.enabled),false);
await setup.getByText('How do you work in Live?',{exact:true}).waitFor();
await page.screenshot({path:`${artifacts}/fresh-experience.png`});
// Choosing in Settings must end the setup step too: both read App's state.
await page.evaluate(()=>window.emitFixture('menu://settings'));
await page.getByLabel('New to Live').check();
await page.getByRole('button',{name:'Done',exact:true}).click();
await page.locator('.card__main').waitFor({state:'visible'});
assert.equal(await page.evaluate(()=>window.experience),'new_to_live','setup saves the chosen level');
assert.equal(await page.locator('.setup').count(),0,'install setup ends before the set goal');
await page.getByLabel('Goal (optional)',{exact:true}).waitFor();
await page.getByRole('button',{name:'Start chatting',exact:true}).click();
await page.screenshot({path:`${artifacts}/empty-chat.png`});
assert.equal(await page.getByLabel('Ask about the set',{exact:true}).isEnabled(),true);
assert.equal(await page.evaluate(()=>localStorage.getItem('copilot.setupDone')),'1');
for (const access of ['expired','revoked']) {
await page.goto('http://127.0.0.1:1423?access='+access);
const ended=access==='revoked'?'Your access was revoked. Contact Mixing Pal.':'Your pilot access has ended. Contact Mixing Pal to continue.';
// A revoked member sees the account panel on the card; an expired pilot keeps chat.
if(access==='revoked')await page.locator('.card__account').getByText(ended).waitFor();
else await page.getByText('Check your account access in Settings.').waitFor();
await page.evaluate(()=>window.emitFixture('menu://settings'));
await page.locator('.card__settings').getByText(ended).waitFor();
const sharing=page.locator('.card__settings').getByLabel('Share advice and outcomes to help improve Mixing Pal');
assert.equal(await sharing.count(),1,access+' accounts must retain a withdrawal control');
assert.equal(await sharing.isChecked(),true);
await sharing.uncheck();
await page.waitForFunction(()=>window.account.capture===false);
assert.equal(await sharing.isEnabled(),false,access+' accounts must not enable sharing');
await page.getByRole('button',{name:'Done',exact:true}).click();
assert.equal(await page.getByLabel('Ask about the set',{exact:true}).isEnabled(),false);
}
await page.clock.install();
for(const state of ['held','paused']) {
await page.goto('http://127.0.0.1:1423?'+state);
await page.getByLabel('Ask about the set',{exact:true}).waitFor();
await page.getByText(state==='held'?'Checking the last request’s usage. Please wait.':'Model access is temporarily paused.').waitFor();
assert.equal(await page.getByLabel('Ask about the set',{exact:true}).isEnabled(),false);
await page.evaluate(()=>{window.account={...window.account,can_ask:true,reserved_micro_usd:0,service_paused:false};window.requests=[];});
await page.clock.fastForward(31000);
await page.waitForTimeout(100);
assert.equal(await page.getByLabel('Ask about the set',{exact:true}).isEnabled(),true,'reconciliation should restore asking');
const refreshed=await page.evaluate(()=>window.requests.filter(x=>x.cmd==='account_status').length);
assert.equal(refreshed,1);
await page.clock.fastForward(31000);
assert.equal(await page.evaluate(()=>window.requests.filter(x=>x.cmd==='account_status').length),refreshed,'stop polling once usage settles');
}
for (const ceiling of [520,360]) {
await page.goto('http://127.0.0.1:1423?access=active');
await page.getByLabel('Ask about the set',{exact:true}).waitFor();
await page.evaluate(ceiling=>document.documentElement.style.setProperty('--card-max-height',`${ceiling}px`),ceiling);
await page.evaluate(()=>window.emitFixture('menu://settings'));
await page.getByRole('button',{name:'Report a problem',exact:true}).click();
const report=page.locator('dialog.report');
await page.waitForFunction(ceiling=>innerHeight===ceiling,ceiling);
assert.equal(await report.getByLabel('Include diagnostics for this report').evaluate(e=>{
 const r=e.getBoundingClientRect(),body=e.closest('.report__body').getBoundingClientRect();
 return r.top>=body.top && r.bottom<=body.bottom;
}),true,'diagnostic choice starts in view');
await report.getByLabel('What went wrong?',{exact:true}).press('Tab');
await page.keyboard.press('Tab');
assert.equal(await report.locator('summary').evaluate(e=>e===document.activeElement),true,'optional details are keyboard reachable');
await page.keyboard.press('Enter');
assert.equal(await report.locator('details').getAttribute('open'),'');
await report.getByLabel('What went wrong?',{exact:true}).fill('Could not ask another question.');
await page.evaluate(()=>window.reportSubmitFails=true);
await report.getByRole('button',{name:'Send report',exact:true}).click();
const alert=report.getByRole('alert');await alert.waitFor();
assert.equal(await alert.evaluate(e=>{
 const r=e.getBoundingClientRect();
 const body=e.closest('.report__body');
 const clip=body?body.getBoundingClientRect():{top:0,bottom:innerHeight};
 return r.top>=clip.top && r.bottom<=clip.bottom;
}),true,'send failure must be visible without scrolling');
await page.screenshot({path:`${artifacts}/report-error-${ceiling}.png`});
await page.evaluate(()=>window.reportSubmitFails=false);
await report.getByRole('button',{name:'Retry',exact:true}).click();
await report.getByRole('heading',{name:'Report sent',exact:true}).waitFor();
assert.deepEqual(await page.evaluate(()=>window.requests.filter(r=>r.cmd==='report_submit').map(r=>r.args.input)),
 await page.evaluate(()=>{const input=window.requests.find(r=>r.cmd==='report_submit').args.input;return [input,input];}),'retry preserves the original report');
}
for (const ceiling of [520,360]) {
await page.goto('http://127.0.0.1:1423?access=active&update=delayed&queued');
const composer=page.getByLabel('Ask about the set',{exact:true});
await composer.waitFor();
await page.evaluate(ceiling=>document.documentElement.style.setProperty('--card-max-height',`${ceiling}px`),ceiling);
await composer.fill('First question fails');await composer.press('Enter');
await page.waitForFunction(()=>!!window.failModel);await page.evaluate(()=>window.failModel());
async function reportFrom(scope){await scope.getByRole('button',{name:'More actions',exact:true}).click();await page.getByRole('menuitem',{name:'Report a problem',exact:true}).click();}
const reportButton=page.locator('.card__exchange').last().getByRole('button',{name:'More actions',exact:true});
await reportFrom(page.locator('.card__exchange').last());
const dialog=page.getByRole('dialog',{name:'Report a problem',exact:true});
const description=dialog.getByLabel('What went wrong?',{exact:true});
assert.equal(await description.evaluate(e=>e===document.activeElement),true);
await description.fill('The question failed.\n'.repeat(120));
await description.press('Enter');
assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.cmd==='report_submit').length),0,'textarea Enter does not submit');
assert.equal(await dialog.getByLabel('Include diagnostics for this report').isChecked(),false);
await dialog.getByLabel('Include diagnostics for this report').check();
await dialog.getByText(/Some technical details are unavailable/).waitFor();
await page.evaluate(()=>window.finishUpdate());
assert.equal(await page.locator('dialog[open]').count(),1,'update cannot cover report');
const cancel=dialog.getByRole('button',{name:'Cancel',exact:true});
await page.waitForFunction(ceiling=>innerHeight===ceiling,ceiling);
const bounds=await cancel.boundingBox();
assert.ok(bounds.y>=0 && bounds.y+bounds.height<=await page.evaluate(()=>innerHeight),'report actions stay visible');
await page.screenshot({path:`${artifacts}/report-${ceiling}.png`});
await cancel.focus();await page.keyboard.press('Tab');
assert.equal(await description.evaluate(e=>e===document.activeElement),true,'Tab stays inside report');
await dialog.getByRole('button',{name:'Send report',exact:true}).click();
await page.locator('dialog.report').getByText(/Waiting to send/).waitFor();
await page.locator('dialog.report').getByRole('button',{name:'Done',exact:true}).click();
await page.getByRole('dialog',{name:'Mixing Pal update'}).waitFor();
await page.getByRole('button',{name:'Not now',exact:true}).click();
await composer.fill('Keep this draft');
await reportFrom(page.locator('.card__exchange').last());await description.press('Escape');
assert.equal(await dialog.count(),0);
assert.equal(await reportButton.evaluate(e=>e===document.activeElement),true,'Escape restores report trigger');
assert.equal(await composer.inputValue(),'Keep this draft');
await page.reload();
await page.getByLabel('Ask about the set',{exact:true}).waitFor();
await page.evaluate(()=>window.emitFixture('menu://settings'));
await page.getByRole('button',{name:'Recent reports',exact:true}).click();
await page.getByText(/Waiting to send/).first().waitFor();
}
await page.goto('http://127.0.0.1:1423?paused&disconnected');
await page.getByText('Not connected',{exact:false}).first().waitFor();
await page.evaluate(()=>window.emitFixture('menu://settings'));
await page.getByRole('button',{name:'Report a problem',exact:true}).click();
const settingsReport=page.getByRole('dialog',{name:'Report a problem',exact:true});
await settingsReport.getByText(/No conversation is included/).waitFor();
await settingsReport.getByLabel('What went wrong?',{exact:true}).fill('Live is disconnected');
await settingsReport.getByRole('button',{name:'Send report',exact:true}).click();
await page.locator('dialog.report').getByRole('heading',{name:'Report sent',exact:true}).waitFor();
const submitted=await page.evaluate(()=>window.requests.find(r=>r.cmd==='report_submit').args.input);
assert.equal(submitted.includeDiagnostics,false);assert.equal(submitted.exchange,undefined);
await page.locator('dialog.report').getByRole('button',{name:'Done',exact:true}).click();
await page.goto('http://127.0.0.1:1423?access=active');
const answerComposer=page.getByLabel('Ask about the set',{exact:true});
await answerComposer.fill('Answer to report');await answerComposer.press('Enter');
await page.waitForFunction(()=>!!window.finishModel);await page.evaluate(()=>window.finishModel());
await page.locator('.card__exchange').last().getByRole('button',{name:'More actions',exact:true}).click();
await page.getByRole('menuitem',{name:'Report a problem',exact:true}).click();
await page.getByRole('dialog',{name:'Report a problem',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
assert.deepEqual(errors,[]);
console.log('PASS report consent, offline receipts/restart, failure/answer/settings entry points, report focus and update coordination, update dismissal, keyboard focus, fixed settings footer, onboarding spacing, service recovery, held usage recovery, expired/revoked withdrawal, sign-in-first fresh setup, setup sharing choice, shared-advice deletion, stale consent response, outcome rating, heard field, rating set switch, window geometry');
} catch(e){await page.screenshot({path:`${artifacts}/failure.png`});console.log(errors);throw e;} finally {await browser.close();server.kill();closeSync(log);}
