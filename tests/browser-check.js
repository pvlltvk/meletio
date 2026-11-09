async (page, options = {}) => {
  const context = await page.context().browser().newContext();
  await context.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      const buffer = new ArrayBuffer(44 + 16000);
      const view = new DataView(buffer);
      const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
      text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE');
      text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
      view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
      view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, 16000, true);
      const silentTestAudio = 'data:audio/wav;base64,' + btoa(String.fromCharCode(...new Uint8Array(buffer)));
      DATA.decks[0].words.forEach(word => { word.audio = silentTestAudio; });
    });
  });
  page = await context.newPage();
  try {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const passed = [];
  const root = options.url || 'http://127.0.0.1:4173/preview.html';
  const capture = async name => { if (options.screenshotDirectory) await page.screenshot({path: options.screenshotDirectory + '/' + name + '.png', fullPage: true}); };
  const settings = () => page.getByRole('button', {name: 'Settings', exact: true}).click();
  const correctAnswer = async () => {
    const id = await page.evaluate(() => questions[position].word.id);
    await page.locator(`[data-answer="${id}"]`).click();
  };
  await page.goto(root);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.setViewportSize({width:390,height:844});
  await settings();
  check(!(await page.locator('#auto-pronounce').isChecked()), 'Autoplay must default off');
  await page.locator('#auto-pronounce').check();
  await page.reload();
  await settings();
  check(await page.locator('#auto-pronounce').isChecked(), 'Autoplay preference not restored');
  await page.locator('#auto-pronounce').uncheck();
  passed.push('autoplay off by default; preference survives reload');
  await page.getByRole('button',{name:'Vocabulary',exact:true}).click();
  await page.locator('#search').fill('καφεσ');
  check(await page.locator('.word-card').count()===1,'Final sigma search');
  await page.locator('.word-card').click();
  await page.locator('[data-audio]').click();
  await page.waitForTimeout(250);
  const real = await page.evaluate(()=>({time:audio.current?.audio.currentTime,ready:audio.current?.audio.readyState}));
  check(real.time>0&&real.ready>=2,'Silent test audio did not decode/play');
  await page.getByRole('button',{name:'Vocabulary',exact:true}).click();
  check(await page.locator('#search').inputValue()==='καφεσ','Search was lost');
  await page.waitForFunction(()=>Boolean(document.activeElement.dataset.word));
  passed.push('Greek sigma search, preserved query and silent test audio playback');
  await page.evaluate(()=>{
    stopAudio();
    window.qaAudio={created:0,played:0,paused:0,errors:0,block:false};
    window.Audio=class {
      constructor(source){this.src=source;qaAudio.created++;}
      play(){qaAudio.played++;return qaAudio.block?Promise.reject(new Error('Simulated browser rejection')):Promise.resolve();}
      pause(){qaAudio.paused++;}
    };
    const original=audio.onError;
    audio.onError=(...args)=>{qaAudio.errors++;original(...args);};
  });
  await page.getByRole('button',{name:'Study',exact:true}).click();
  await page.locator('[data-start="all"]').click();
  await correctAnswer();
  check(await page.evaluate(()=>qaAudio.played)===0,'Disabled autoplay played');
  check(await page.locator('[aria-disabled="true"]').count()===4,'Answers not locked');
  const answered = await page.evaluate(()=>answers.length);
  await page.locator('[data-answer]').first().dispatchEvent('click');
  check(await page.evaluate(()=>answers.length)===answered,'Answer scored twice');
  await page.locator('[data-screen="study"]').click();
  await page.locator('[data-resume]').click();
  check(await page.evaluate(()=>answers.length)===answered,'Resume changed score');
  await page.locator('[data-screen="study"]').click();
  await settings();
  await page.locator('#auto-pronounce').check();
  await page.getByRole('button',{name:'Study',exact:true}).click();
  await page.locator('[data-start="all"]').click();
  check(await page.evaluate(()=>qaAudio.played)===0,'Audio played before answering');
  await correctAnswer();
  check(await page.evaluate(()=>qaAudio.played)===1,'Enabled autoplay did not play');
  check(await page.evaluate(()=>document.activeElement.id)==='continue','Continue not focused');
  await page.locator('[data-audio]').click();
  await page.locator('[data-audio]').click();
  check(await page.evaluate(()=>qaAudio.errors)===0,'Rapid Listen generated error');
  await page.locator('#continue').click();
  check(await page.evaluate(()=>qaAudio.paused)>0,'Navigation did not stop audio');
  await page.evaluate(()=>qaAudio.block=true);
  await correctAnswer();
  await page.waitForTimeout(40);
  check(await page.evaluate(()=>qaAudio.errors)===1,'Blocked autoplay not reported');
  await page.locator('#continue').click();
  await correctAnswer();
  await page.waitForTimeout(40);
  check(await page.evaluate(()=>qaAudio.errors)===1,'Blocked autoplay reported repeatedly');
  await page.evaluate(()=>qaAudio.block=false);
  await page.locator('[data-audio]').click();
  check(await page.locator('#notice').innerText()==='','Successful retry left stale notice');
  check(await page.locator('#announcer [lang]').count()>=2,'Feedback announcement lacks language metadata');
  await page.evaluate(()=>{qaAudio.block=false;window.dispatchEvent(new Event('pagehide'));});
  check(await page.evaluate(()=>audio.current)===null,'pagehide did not stop audio');
  await page.evaluate(()=>{const descriptor=Object.getOwnPropertyDescriptor(document,'hidden');Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));if(descriptor)Object.defineProperty(document,'hidden',descriptor);else delete document.hidden;});
  check(await page.evaluate(()=>audio.current)===null,'Hidden page did not stop audio');
  passed.push('autoplay timing/on/off, answer lock, resume, rapid Listen, navigation/pagehide stop, blocked notice once');
  await page.locator('[data-screen="study"]').click();
  await settings();
  await page.locator('#auto-pronounce').uncheck();
  await page.getByRole('button',{name:'Study',exact:true}).click();
  await page.locator('[data-start="all"]').click();
  for(let index=0;index<10;index++){
    const state=await page.evaluate(()=>({correct:questions[position].word.id,options:questions[position].options.map(word=>word.id)}));
    await page.locator(`[data-answer="${index===0?state.options.find(id=>id!==state.correct):state.correct}"]`).click();
    await page.locator('#continue').click();
  }
  const score=await page.locator('.score-panel').innerText();
  check(score.includes('9 / 10'),'Incorrect results');
  await page.locator('[data-start="mistakes"]').click();
  check(await page.evaluate(()=>questions.length)===1,'Retry should contain one question');
  check(await page.locator('[data-answer]').count()===4,'Retry lost distractor pool');
  await correctAnswer();
  await page.locator('#continue').click();
  await capture('results');
  await page.locator('[data-screen="study"]').click();
  check(await page.locator('[data-resume]').count()===0,'Finished session offered resume');
  passed.push('9/10 scoring, missed-only retry using full deck, completed session ends');
  await settings();
  await page.locator('[name="learning-set"][value="demo-ar"]').check();
  check(await page.locator('[role="radiogroup"]').isVisible(),'Deck selection moved away from Settings');
  check(await page.evaluate(()=>document.activeElement.name)==='learning-set','Deck selection lost focus');
  check(await page.evaluate(()=>questions.length===0&&answers.length===0&&searchQuery===''&&lastSession===null),'Deck reset');
  await page.getByRole('button',{name:'Vocabulary',exact:true}).click();
  await page.locator('#search').fill('كتاب');
  check(await page.locator('.word-card').count()===1,'Arabic search');
  check(await page.locator('.word-card bdi').first().getAttribute('dir')==='rtl','RTL missing');
  await page.locator('.word-card').click();
  check(await page.locator('[data-audio]').count()===0,'Missing audio has Listen');
  check((await page.locator('main').innerText()).includes('No recording'),'Missing audio notice');
  await page.getByRole('button',{name:'Study',exact:true}).click();
  await page.locator('[data-start="all"]').click();
  const audioBefore=await page.evaluate(()=>qaAudio.created);
  await correctAnswer();
  check(await page.evaluate(()=>qaAudio.created)===audioBefore,'Missing recording created player');
  check(await page.locator('[data-audio]').count()===0,'Missing feedback has Listen');
  await capture('arabic');
  passed.push('Arabic configuration, RTL terms, search, reset state, optional recordings');
  const layouts=[];
  for(const size of [{width:320,height:568},{width:390,height:844},{width:768,height:844},{width:1280,height:900}]){
    await page.setViewportSize(size);
    for(const id of ['everyday-el','demo-ar']){
      await page.evaluate(id=>{stopAudio();deck=decks.find(d=>d.id===id);questions=[];answers=[];selected=null;position=0;},id);
      for(const route of ['study','vocabulary','settings']){
        await page.evaluate(route=>{screen=route;render();},route);
        check(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)),`Overflow ${id}/${route}/${size.width}`);
      }
      if(size.width<780){
        await page.evaluate(()=>{screen='vocabulary';searchQuery='';render();});
        await page.locator('.word-card').last().focus();
        const obscured=await page.locator('.word-card').last().evaluate(el=>{const rect=el.getBoundingClientRect();const nav=document.querySelector('.nav').getBoundingClientRect();return rect.bottom>nav.top+1;});
        check(!obscured,`Focused word hidden by navigation ${id}/${size.width}`);
      }
      await page.evaluate(()=>startPractice());
      check(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)),`Practice overflow ${id}/${size.width}`);
      await correctAnswer();
      const visible=await page.locator('#continue').evaluate(el=>{const rect=el.getBoundingClientRect();return rect.top>=0&&rect.bottom<=innerHeight;});
      check(visible,`Continue not visible ${id}/${size.width}`);
    }
    layouts.push(size);
  }
  passed.push('both decks fit 4 viewport sizes; Continue visible on short screens');
  await page.evaluate(()=>{
    const third={id:'demo-tr',title:'Turkish fixture',termLang:'tr',meaningLang:'en',termDir:'ltr',meaningDir:'ltr',words:deck.words.slice(0,4).map((w,i)=>({...w,id:String(i+1),term:['IŞIK','İNCİR','SU','EV'][i],meaning:['light','fig','water','house'][i],termLang:'tr',audio:null}))};
    decks.push(third);deck=third;screen='vocabulary';searchQuery='ışık';render();
  });
  check(await page.locator('.word-card').count()===1,'Config-only third language');
  check((await page.locator('main').innerText()).includes('Turkish'),'Third language label');
  await page.evaluate(()=>{deck={...decks[0],words:decks[0].words.slice(0,3)};questions=[];screen='study';render();});
  check(await page.locator('[data-start="all"]').count()===0,'Small deck offered quiz');
  passed.push('third language via configuration only; small-deck unavailable state');
  await page.evaluate(()=>{
    Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new Error('Simulated storage denial');}});
  });
  await settings();
  await page.locator('#auto-pronounce').check();
  check(await page.locator('.storage-note').isVisible(),'Storage fallback not visible');
  check(await page.locator('#auto-pronounce').isChecked(),'Storage failure loses in-memory preference');
  passed.push('denied browser storage falls back to in-memory preference');
  await page.setViewportSize({width:390,height:844});
  await capture('settings');
  await page.getByRole('button',{name:'Study',exact:true}).click();
  await capture('study');
  return {passed,layouts,testAudio:real};
  } finally { await context.close(); }
}
