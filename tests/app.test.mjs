/* Прогон: см. tests/README.md
   PLAYWRIGHT_MODULE нужен, если playwright установлен глобально. */
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import fs from 'node:fs';
import path from 'node:path';

/* Готовим копию приложения с адресом тестовой заглушки. */
const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = path.join(import.meta.dirname, 'app-under-test.html');
fs.writeFileSync(TMP, fs.readFileSync(path.join(ROOT, 'sonny-v9.html'), 'utf8')
  .replace("CHAT_URL:''", "CHAT_URL:'http://127.0.0.1:8788'"));
const FILE = 'file://' + TMP;
let ok=0,fail=0;
const chk=(n,c,extra='')=>{ if(c){console.log('  OK  '+n);ok++;} else {console.log('  FAIL '+n+(extra?' -> '+extra:''));fail++;} };
const browser=await chromium.launch();

async function fresh(){
  const ctx=await browser.newContext();
  const p=await ctx.newPage();
  const errs=[];
  p.on('pageerror',e=>errs.push(e.message));
  p.on('console',m=>{if(m.type()==='error'&&!/CERT_AUTHORITY|net::ERR_CERT|Failed to load resource|ERR_UNSAFE_PORT/.test(m.text()))errs.push('console: '+m.text());});
  await p.goto(FILE); await p.waitForTimeout(400);
  return {ctx,p,errs};
}
async function onboard(p){
  await p.fill('#ob-name','Тестик'); await p.fill('#ob-bd','2026-04-01');
  await p.click('text=Начать 🌙'); await p.waitForTimeout(500);
}
async function ask(p,text){
  await p.click('.tabbtn:has-text("Сонни")'); await p.waitForTimeout(200);
  await p.fill('#ci',text); await p.press('#ci','Enter'); await p.waitForTimeout(1200);
  return {log:await p.locator('#chatlog').textContent(),
          bubbles:await p.locator('#chatlog .msg.user').count(),
          input:await p.inputValue('#ci')};
}
const setMode=async m=>{const r=await fetch('http://127.0.0.1:8788/mode/'+m);await r.text();};

console.log('=== A. Онбординг и сохранение ===');
{
  const {ctx,p,errs}=await fresh();
  chk('онбординг показан',await p.locator('#onboard').isVisible());
  await onboard(p);
  chk('онбординг закрылся',await p.locator('#onboard').isHidden());
  const prof=await p.evaluate(()=>localStorage.getItem('sonny:profile'));
  chk('профиль в localStorage',!!prof&&prof.includes('Тестик'));
  await p.reload(); await p.waitForTimeout(500);
  chk('после перезагрузки данные на месте',(await p.locator('#babychip').textContent()).includes('Тестик'));
  chk('ошибок страницы нет',errs.length===0,errs.join('; '));
  await ctx.close();
}

console.log('=== B. Трекер снов (подъём -> засыпание -> пробуждение) ===');
{
  const {ctx,p,errs}=await fresh(); await onboard(p);
  // Утренний подъём
  await p.click('#mainbtns button');
  await p.waitForTimeout(250);
  await p.click('text=Подтвердить');
  await p.waitForTimeout(400);
  const d1=await p.evaluate(()=>localStorage.getItem('sonny:data8'));
  chk('подъём записался',!!d1&&d1.includes('morningWake'),String(d1).slice(0,80));
  // Засыпание
  await p.click('#mainbtns button');
  await p.waitForTimeout(250);
  await p.click('text=Подтвердить');
  await p.waitForTimeout(400);
  const d2=await p.evaluate(()=>localStorage.getItem('sonny:data8'));
  chk('засыпание записалось',!!d2&&/"sleeping":\{/.test(d2),String(d2).slice(0,90));
  // Перезагрузка
  await p.reload(); await p.waitForTimeout(600);
  const d3=await p.evaluate(()=>localStorage.getItem('sonny:data8'));
  chk('сон выжил перезагрузку',!!d3&&/"sleeping":\{/.test(d3));
  {const sc=(await p.locator('#statecard').textContent());chk('экран показывает идущий сон',/Дневной сон|Ночной сон|Спит/.test(sc)&&sc.includes('Уснул'),sc.replace(/\s+/g,' ').slice(0,70));}
  // Пробуждение
  await p.click('#mainbtns button');
  await p.waitForTimeout(250);
  await p.click('text=Подтвердить');
  await p.waitForTimeout(500);
  const d4=await p.evaluate(()=>JSON.parse(localStorage.getItem('sonny:data8')));
  chk('сон попал в дневник',Array.isArray(d4.logs)&&d4.logs.length>=1,'записей: '+(d4.logs||[]).length);
  chk('ошибок страницы нет',errs.length===0,errs.join('; '));
  await ctx.close();
}

console.log('=== C. Все вкладки открываются ===');
{
  const {ctx,p,errs}=await fresh(); await onboard(p);
  for(const t of ['История','Режим','Сонни','Сегодня']){
    await p.click(`.tabbtn:has-text("${t}")`); await p.waitForTimeout(250);
  }
  chk('переключение вкладок без ошибок',errs.length===0,errs.join('; '));
  await ctx.close();
}

console.log('=== D. Чат без настроенного бэкенда ===');
{
  const {ctx,p,errs}=await fresh(); await onboard(p);
  await p.evaluate(()=>{CONFIG.CHAT_URL='';});
  const r=await ask(p,'Сколько спать в 6 месяцев?');
  chk('честное сообщение, а не «нет связи»',r.log.includes('не подключён'));
  chk('вопрос убран с экрана',r.bubbles===0,'пузырей: '+r.bubbles);
  chk('текст вернулся в поле ввода',r.input==='Сколько спать в 6 месяцев?',r.input);
  chk('история чата не разошлась с экраном',await p.evaluate(()=>chatHistory.length)===0);
  chk('ошибок страницы нет',errs.length===0,errs.join('; '));
  await ctx.close();
}

console.log('=== E. Чат с рабочим бэкендом ===');
{
  await setMode('ok');
  const {ctx,p,errs}=await fresh(); await onboard(p);
  const r=await ask(p,'Сколько спать в 6 месяцев?');
  chk('ответ отрисован',r.log.includes('ВБ 2:15'));
  chk('вопрос остался на экране',r.bubbles===1);
  chk('поле ввода пустое',r.input==='');
  chk('в истории вопрос и ответ',await p.evaluate(()=>chatHistory.length)===2);
  chk('ошибок страницы нет',errs.length===0,errs.join('; '));
  await ctx.close();
}

console.log('=== F. Бэкенд отвечает 429 (перебор запросов) ===');
{
  await setMode('429');
  const {ctx,p,errs}=await fresh(); await onboard(p);
  const r=await ask(p,'вопрос');
  chk('текст про «подождите минуту»',r.log.includes('Подождите минуту'));
  chk('вопрос снят с экрана',r.bubbles===0);
  chk('текст возвращён для повтора',r.input==='вопрос');
  chk('ошибок страницы нет',errs.length===0,errs.join('; '));
  await ctx.close();
}

console.log('=== G. Бэкенд отвечает 500 ===');
{
  await setMode('500');
  const {ctx,p,errs}=await fresh(); await onboard(p);
  const r=await ask(p,'вопрос');
  chk('внятное сообщение',r.log.includes('не отвечает'));
  chk('вопрос снят с экрана',r.bubbles===0);
  chk('ошибок страницы нет',errs.length===0,errs.join('; '));
  await ctx.close();
}

console.log('=== H. Модель отказалась отвечать (refusal) ===');
{
  await setMode('refusal');
  const {ctx,p,errs}=await fresh(); await onboard(p);
  const r=await ask(p,'вопрос про здоровье');
  chk('отсылка к педиатру',r.log.includes('педиатру'));
  chk('ошибок страницы нет',errs.length===0,errs.join('; '));
  await ctx.close();
}

console.log('=== I. Бэкенд вернул мусор вместо JSON ===');
{
  await setMode('garbage');
  const {ctx,p,errs}=await fresh(); await onboard(p);
  const r=await ask(p,'вопрос');
  chk('приложение не зависло на «печатает»',!r.log.includes('печатает'));
  chk('показано сообщение об ошибке',r.log.includes('Нет связи')||r.log.includes('не отвечает'));
  chk('ошибок страницы нет',errs.length===0,errs.join('; '));
  await ctx.close();
}

console.log('=== J. Бэкенд вернул пустой ответ ===');
{
  await setMode('empty');
  const {ctx,p,errs}=await fresh(); await onboard(p);
  const r=await ask(p,'вопрос');
  chk('подстановка вежливого текста',r.log.includes('Не получилось ответить'));
  chk('ошибок страницы нет',errs.length===0,errs.join('; '));
  await ctx.close();
}

console.log('=== K. Адрес бэкенда недоступен ===');
{
  const {ctx,p,errs}=await fresh(); await onboard(p);
  await p.evaluate(()=>{CONFIG.CHAT_URL='http://127.0.0.1:9/нет';});
  const r=await ask(p,'вопрос');
  chk('сообщение «нет связи»',r.log.includes('Нет связи'));
  chk('вопрос снят с экрана',r.bubbles===0);
  chk('ошибок страницы нет',errs.length===0,errs.join('; '));
  await ctx.close();
}

console.log('=== L. localStorage недоступен (режим инкогнито / запрет куки) ===');
{
  const ctx=await browser.newContext();
  const p=await ctx.newPage();
  const errs=[];
  p.on('pageerror',e=>errs.push(e.message));
  await p.addInitScript(()=>{
    const boom=()=>{throw new Error('доступ к хранилищу запрещён');};
    Object.defineProperty(window,'localStorage',{get(){return {getItem:boom,setItem:boom,removeItem:boom};}});
  });
  await p.goto(FILE);
  await p.waitForTimeout(500);
  chk('приложение загрузилось, а не упало',await p.locator('.phone').isVisible());
  await onboard(p);
  chk('онбординг прошёл без падения',await p.locator('#onboard').isHidden());
  await p.click('.tabbtn:has-text("Сегодня")').catch(()=>{});
  chk('ошибок страницы нет',errs.length===0,errs.join('; '));
  await ctx.close();
}

console.log('\nИТОГ: прошло '+ok+', упало '+fail);
await browser.close();
process.exit(fail?1:0);
