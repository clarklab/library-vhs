import { test, expect } from '@playwright/test';

const image = { name: '24-tapes.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700"><rect width="1200" height="700" fill="#283730"/>${Array.from({length:24},(_,i)=>`<rect x="${30+(i%12)*96}" y="${30+Math.floor(i/12)*330}" width="80" height="300" fill="${i%2?'#e6c68c':'#daa79f'}"/>`).join('')}</svg>`) };
const result = {
  tapes: Array.from({length:24},(_,i)=>({title:`Tape ${i+1}`,format:'VHS',confidence:'high',needsReview:false,sourceIndex:i+1,marker:{x:(70+i%12*96)/1200,y:Math.floor(i/12) ? .72 : .26}})),
  count:24, reportedCount:24, needsVerification:false, warnings:[],
  verification:{status:'matched',countedCount:24,listedCount:24,uncertainCount:0},
};
async function setup(page) {
  const errors = [], creates = [];
  const control = {status:'running',stage:'reading',result:null};
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{localStorage.setItem('vhsvault.token','feedback-test');localStorage.setItem('vhsvault.installDismissedAt',String(Date.now()));});
  await page.route('**/api/**',async route=>{
    const request=route.request(), path=new URL(request.url()).pathname;
    let response={};
    if(path==='/api/auth/me') response={user:{id:'feedback-user',email:'feedback@example.com'}};
    if(path==='/api/tapes') response={tapes:[]};
    if(path==='/api/scan-jobs') creates.push(request.postDataJSON().clientId);
    if(path.startsWith('/api/scan-jobs')) response={job:{id:`job-${creates.at(-1)}`,createdAt:new Date(Date.now()-90000).toISOString(),startedAt:new Date(Date.now()-90000).toISOString(),deadlineAt:new Date(Date.now()+390000).toISOString(),updatedAt:new Date().toISOString(),...control},pollAfterMs:750};
    await route.fulfill({status:path==='/api/scan-jobs'?202:200,json:response});
  });
  await page.goto('/'); await page.locator('[data-start-scan]').click();
  await page.locator('[data-file-library]').setInputFiles(image);
  await expect(page.locator('[data-run]')).toContainText('Read 1 photo');
  return {control,creates,errors};
}

test('a long 24-tape scan shows elapsed progress and reconnects after refresh without a second job',async({page})=>{
  await page.setViewportSize({width:1440,height:1060});
  const app=await setup(page);
  await page.locator('[data-run]').click();
  await expect(page.locator('[data-feedback-title]')).toHaveText('Reading your shelf…');
  await expect(page.locator('[data-elapsed]')).toContainText('1m');
  await expect(page.locator('[data-feedback-description]')).toContainText('few minutes');
  await expect(page.locator('[data-slow-note]')).toBeVisible();
  await expect(page.locator('[data-finish]')).not.toBeVisible();
  await page.screenshot({path:'test-results/scan-progress-desktop.png',fullPage:true});
  app.control.progress={independentCount:24,countFinished:true};
  await expect(page.locator('[data-active-photos]')).toContainText('24 possible tapes counted');
  app.control.stage='verifying';app.control.result=result;
  await expect(page.locator('[data-feedback-title]')).toHaveText('Double-checking your tapes…');
  await page.reload(); await page.locator('[data-start-scan]').click();
  await expect(page.locator('[data-feedback-title]')).toHaveText('Pick up where you left off.');
  await page.locator('[data-feedback-action]').click();
  await expect(page.locator('[data-feedback-title]')).toHaveText('Double-checking your tapes…');
  expect(app.creates).toHaveLength(1);
  app.control.status='completed';app.control.stage='completed';
  await expect(page.locator('.scan-tape-row')).toHaveCount(24);
  await expect(page.locator('[data-feedback-title]')).toHaveText('24 titles are ready to review.');
  expect(app.errors).toEqual([]);
});

test('mobile failure explains the reason visibly and retries only the failed job',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const app=await setup(page);
  Object.assign(app.control,{status:'failed',stage:'failed',error:{error:'The provider took too long.',code:'AI_TIMEOUT',status:504,retryable:true,requestId:'scan-example-reference'}});
  await page.locator('[data-run]').click();
  await expect(page.locator('.scan-failure h3')).toHaveText('The scan timed out before it finished.');
  await expect(page.locator('.scan-failure > div > p')).toBeVisible();
  await expect(page.locator('[data-retry-id]')).toBeEnabled();
  await expect(page.locator('[data-retry-id]')).toHaveText('Retry photo');
  await expect(page.locator('.scan-failure details')).not.toHaveAttribute('open','');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({path:'test-results/scan-error-mobile.png',fullPage:true});
  Object.assign(app.control,{status:'completed',stage:'completed',result,error:null});
  await page.locator('[data-retry-id]').click();
  await expect(page.locator('.scan-tape-row')).toHaveCount(24);
  expect(app.creates).toHaveLength(2);expect(app.creates[0]).not.toBe(app.creates[1]);
  expect(app.errors).toEqual([]);
});

test('failed verification keeps all initial titles with an explicit review warning',async({page})=>{
  const app=await setup(page);
  Object.assign(app.control,{status:'completed',stage:'completed',result,verificationFailure:{error:'The final check timed out.',code:'AI_TIMEOUT',status:504,retryable:true}});
  await page.locator('[data-run]').click();
  await expect(page.locator('.scan-tape-row')).toHaveCount(24);
  await expect(page.locator('.scan-verification-warning')).toContainText('Your first reading is kept');
  await expect(page.locator('[data-save]')).toBeDisabled();
  await expect(page.locator('[data-photo-confirm]')).toBeVisible();
  await page.locator('[data-photo-confirm]').check();
  await expect(page.locator('[data-save]')).toBeEnabled();
  expect(app.creates).toHaveLength(1);expect(app.errors).toEqual([]);
});
