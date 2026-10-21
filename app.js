'use strict';
const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const fields = {model:'model', n:'n', p:'p', radius:'radius', degree:'degree', edges:'edgeCount',
  epsilon:'epsilon', seed:'seed', guess_cost:'guessCost', hint_cost:'hintPenalty', dimension:'dimension', metric:'metric'};
const descriptions = {
  erdos:'G(N, p): each pair of distinct vertices is joined independently with probability p.',
  geometric:'Vertices are sampled uniformly in the unit cube of the chosen dimension. Pairs within the radius are connected using the selected distance metric.',
  regular:'A simple random d-regular graph: every vertex has degree d. Requires 0 ≤ d < N and N × d even. Connectivity is not imposed.',
  planar:'Randomly ordered edges are added only when they preserve planarity. Connected mode begins with a random labeled spanning tree. This is not a uniform sampler of planar graphs.'
};
const palettes = {
  RdBu_r:['#053061','#2166ac','#4393c3','#92c5de','#f7f7f7','#f4a582','#d6604d','#b2182b','#67001f'],
  coolwarm:['#3b4cc0','#6282ea','#8db0fe','#b9d0f9','#dddddd','#f5c4ac','#f49a7b','#de614d','#b40426'],
  PuOr:['#7f3b08','#b35806','#e08214','#fdb863','#f7f7f7','#b2abd2','#8073ac','#542788','#2d004b'],
  viridis:['#440154','#472d7b','#3b528b','#2c728e','#21918c','#28ae80','#5ec962','#addc30','#fde725']
};
let state = null, busy = true, backend, runtimeLabel, saved = false, positions = [], drag = null;
const session = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
let roundKey = session;
const format = value => Math.abs(value) < 5e-10 ? '0' : Number(value.toFixed(7)).toString().replace('-', '−');
const el = (tag, props = {}, content) => {
  const item = document.createElement(tag);
  Object.assign(item, props);
  if (content !== undefined) item.textContent = content;
  return item;
};
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function setBusy(value) {
  busy = value;
  document.querySelectorAll('[data-busy]').forEach(x => x.disabled = value);
  document.querySelectorAll('#configForm input,#configForm select,#settingsDialog input,#settingsDialog select,#labels,#palette,#nodeSize').forEach(x => {
    x.disabled = value || Boolean(x.closest('[data-model]')?.hidden);
  });
  const ended = !state || state.status !== 'playing';
  ['guess', 'guessButton', 'hintButton', 'giveUp'].forEach(id => $(id).disabled = value || ended);
  document.querySelectorAll('.mode,.saved-hints button').forEach(x => x.disabled = value);
}
function updateModel() {
  document.querySelectorAll('[data-model]').forEach(x => {
    x.hidden = x.dataset.model !== $('model').value;
    x.querySelectorAll('input,select').forEach(input => input.disabled = x.hidden);
  });
  $('modelDescription').textContent = descriptions[$('model').value];
  $('degree').max = Math.max(0, Number($('n').value)-1);
  const n = Number($('n').value);
  $('edgeCount').min = $('connected').checked ? Math.max(0, n-1) : 0;
  $('edgeCount').max = n >= 3 ? 3*n-6 : Math.max(0,n-1);
}
function pending() { $('pending').hidden = false; }
function readConfig() {
  const config = {};
  for (const [key, id] of Object.entries(fields)) {
    config[key] = ['model','metric'].includes(key) ? $(id).value : Number($(id).value);
  }
  if ($('seed').value.trim() === '') config.seed = crypto.getRandomValues(new Uint32Array(1))[0];
  config.connected = $('connected').checked;
  return config;
}
function applyConfig(config) {
  for (const [key, id] of Object.entries(fields)) if (key in config) $(id).value = config[key];
  if ('connected' in config) $('connected').checked = config.connected;
  updateModel();
}
async function makeBackend() {
  if (location.protocol === 'file:') throw new Error('Open this game with python run_game.py, or serve the web folder over HTTP.');
  let runtime;
  try {
    const response = await fetch('api/runtime', {signal: AbortSignal.timeout(4000)});
    if (response.ok && (response.headers.get('content-type') || '').includes('application/json')) runtime = await response.json();
  } catch (_) { /* Static hosting uses the worker below. */ }
  if (runtime?.native) {
    runtimeLabel = 'Local Python · NumPy · NetworkX';
    return async request => {
      const response = await fetch('api/action', {method:'POST', headers:{'Content-Type':'application/json','X-Spectrum-Token':runtime.token}, body:JSON.stringify({...request,session})});
      const result = await response.json();
      if (!result.ok) throw new Error(result.error || 'The calculation failed.');
      return result.data;
    };
  }
  runtimeLabel = 'Browser Python · Pyodide · NetworkX';
  return await new Promise((resolve, reject) => {
    const worker = new Worker('worker.js');
    const pendingCalls = new Map();
    let sequence = 0;
    const send = request => new Promise((done, fail) => {
      const id = ++sequence;
      pendingCalls.set(id, {done, fail});
      worker.postMessage({id, request});
    });
    worker.onmessage = ({data}) => {
      if (data.status) { $('loadingText').textContent = data.status; notice(data.status); }
      if (data.ready) resolve(send);
      if (data.fatal) { reject(new Error(data.fatal)); notice(data.fatal, true); }
      if (data.id) {
        const waiting = pendingCalls.get(data.id);
        if (!waiting) return;
        pendingCalls.delete(data.id);
        data.result.ok ? waiting.done(data.result.data) : waiting.fail(new Error(data.result.error));
      }
    };
    worker.onerror = event => {
      const error = new Error(event.message || 'The Python worker failed. Reload to try again.');
      reject(error); pendingCalls.forEach(p => p.fail(error)); pendingCalls.clear(); notice(error.message, true);
    };
  });
}
function colorAt(value, bound) {
  const colors = palettes[$('palette').value];
  const position = Math.max(0, Math.min(1, (value / bound + 1)/2)) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(position));
  const ratio = position - index;
  const rgb = h => [1,3,5].map(i => parseInt(h.slice(i,i+2),16));
  const a = rgb(colors[index]), b = rgb(colors[index+1]);
  return a.map((x,i) => Math.round(x*(1-ratio)+b[i]*ratio));
}
function svgElement(tag, attrs) {
  const node = document.createElementNS(NS,tag);
  for (const [key,value] of Object.entries(attrs)) node.setAttribute(key,value);
  return node;
}
function screenPoint(p) { return [450 + p[0]*232, 280 - p[1]*232]; }
function drawSVG() {
  const svg = $('graph');
  const displayScale = Math.max(1, Math.min(2.5, 700 / $('graphStage').clientWidth));
  svg.replaceChildren();
  const title = svgElement('title',{});
  title.textContent = `${state.model_name}, ${state.config.n} vertices and ${state.edges.length} edges. ${state.active ? 'Colors show an eigenvector.' : 'Unweighted undirected graph.'}`;
  svg.append(title);
  const links = svgElement('g',{'aria-hidden':'true'});
  state.edges.forEach(([a,b]) => {
    const [x1,y1]=screenPoint(positions[a]), [x2,y2]=screenPoint(positions[b]);
    links.append(svgElement('line',{x1,y1,x2,y2,'data-a':a,'data-b':b}));
  });
  svg.append(links);
  const vector = state.active?.vector;
  const bound = vector ? Math.max(...vector.map(Math.abs),1e-12) : 1;
  positions.forEach((position,i) => {
    const [x,y]=screenPoint(position);
    const group = svgElement('g',{class:'node',transform:`translate(${x} ${y})`,'data-node':i});
    const color = vector ? colorAt(vector[i],bound) : [76,93,229];
    const nodeTitle = svgElement('title',{});
    nodeTitle.textContent = `Node ${i}${vector ? ` · component ${format(vector[i])}` : ''}`;
    group.append(nodeTitle,svgElement('circle',{r:Number($('nodeSize').value)*displayScale,fill:`rgb(${color.join(',')})`}));
    if ($('labels').checked) {
      const text = svgElement('text',{});
      text.textContent = i;
      text.style.fontSize = `${12*displayScale}px`;
      if (.299*color[0]+.587*color[1]+.114*color[2]>165) text.style.fill='#253453';
      group.append(text);
    }
    svg.append(group);
  });
}
async function draw() {
  $('graph').style.display = $('renderer').value === 'svg' ? 'block' : 'none';
  $('plot').hidden = $('renderer').value !== 'matplotlib';
  $('canvasNote').hidden = $('renderer').value !== 'svg';
  if ($('renderer').value === 'matplotlib') {
    $('loading').hidden = false;
    $('loadingText').textContent = 'Rendering with Matplotlib…';
    try {
      const result = await backend({action:'plot',palette:$('palette').value,labels:$('labels').checked,node_size:Number($('nodeSize').value)**2*1.7});
      $('plot').src = result.image;
    } catch(error) {
      $('renderer').value='svg'; $('plot').hidden=true; $('graph').style.display='block'; $('canvasNote').hidden=false;
      drawSVG();
      throw error;
    } finally { $('loading').hidden = true; }
  } else drawSVG();
}
function renderState() {
  $('graphTitle').textContent = state.model_name;
  $('graphMeta').textContent = `${state.config.n} vertices · ${state.edges.length} edges`;
  $('score').textContent = state.score.toLocaleString();
  $('found').replaceChildren(document.createTextNode(`${state.found_count} `),el('span',{},`/ ${state.config.n}`));
  $('attempts').textContent = state.attempts;
  $('progress').style.width = `${100*state.found_count/state.config.n}%`;
  $('guessHelp').textContent = `Within ±${state.config.epsilon} counts. Every guess costs ${state.config.guess_cost} points.`;
  $('hintCost').textContent = `−${state.config.hint_cost}`;
  $('roundStatus').textContent = {playing:'IN PLAY',solved:'COMPLETE',given_up:'REVEALED'}[state.status];
  $('roundStatus').classList.toggle('solved',state.status==='solved');
  $('discoveredCount').textContent = `${state.found_count} found`;
  $('seedLabel').textContent = `Seed ${state.config.seed} · unweighted adjacency`;
  $('engineLabel').textContent = runtimeLabel;
  $('layout').value = state.layout;
  $('spectrum').replaceChildren();
  if (!state.modes.length) $('spectrum').append(el('span',{className:'empty-spectrum'},'Your spectrum will appear here.'));
  const occurrences = {};
  state.modes.forEach(mode => {
    const key = format(mode.value);
    occurrences[key] = (occurrences[key] || 0) + 1;
    const button = el('button',{className:`mode${mode.found?'':' revealed'}${state.active?.id===mode.id?' active':''}`,title:`${mode.found?'Found':'Revealed'} eigenvalue ${key}, occurrence ${occurrences[key]}. Show eigenvector.`},key);
    button.setAttribute('aria-pressed',String(state.active?.id===mode.id));
    if (occurrences[key]>1) button.append(el('small',{},`#${occurrences[key]}`));
    button.onclick = () => act({action:'select',id:mode.id});
    $('spectrum').append(button);
  });
  $('savedHints').hidden = !state.hint_ids.length;
  $('savedHints').replaceChildren(document.createTextNode('Revisit hints (free): '));
  state.hint_ids.forEach((id,i) => {
    const button = el('button',{className:'secondary'},`Vector ${i+1}`);
    button.onclick=()=>act({action:'select',id});
    $('savedHints').append(button);
  });
  const active=state.active;
  $('clearVector').hidden = !active;
  $('legend').hidden = !active;
  $('components').hidden = !active;
  $('vectorTitle').textContent = !active ? 'Plain graph' : active.value===null ? 'Hint eigenvector' : `Eigenvector · λ = ${format(active.value)}`;
  $('vectorSubtitle').textContent = !active ? 'Select a found eigenvalue to see its eigenvector.' : active.value===null ? 'Its eigenvalue is still yours to find.' : 'Node color shows the signed component.';
  if (active) {
    const bound = Math.max(...active.vector.map(Math.abs));
    $('legendMin').textContent = format(-bound);
    $('legendMax').textContent = format(bound);
    $('legendGradient').style.background = `linear-gradient(to right, ${palettes[$('palette').value].join(',')})`;
    $('componentValues').replaceChildren(...active.vector.map((value,i)=>el('span',{},`${i}: ${format(value)}`)));
  }
  $('historyCount').textContent = state.attempts;
  $('historyList').replaceChildren(...[...state.history].reverse().map(entry=>el('li',{className:entry.matched?'hit':''},`${format(entry.guess)} → ${entry.matched ? `found ${format(entry.value)}`:'no remaining match'}`)));
  $('saveArea').hidden = state.status !== 'solved';
  $('saveScore').disabled = saved;
  if (state.status==='solved') feedback(`Spectrum complete! All ${state.config.n} eigenvalues found. Final score: ${state.score}.`,'success');
  else if (state.status==='given_up') feedback('Full spectrum revealed. Gray values were not guessed. Select any value to explore its eigenvector.','');
}
function feedback(text,type='') { $('feedback').textContent=text; $('feedback').className=`feedback ${type}`; }
async function act(request) {
  if (busy) return;
  setBusy(true);
  notice(request.action==='new' ? 'Generating your graph…' : '');
  if (request.action==='new') { $('loading').hidden=false; $('loadingText').textContent='Generating your graph…'; }
  let successful=false;
  try {
    state = await backend(request);
    if (request.action==='new' || request.action==='layout') positions=state.positions.map(p=>[...p]);
    if (request.action==='new') {
      saved=false; roundKey=session+'-'+Date.now(); $('saveMessage').textContent=''; $('pending').hidden=true;
      $('guess').value=''; $('components').open=false;
      feedback('Start anywhere. Eigenvalues can be negative, zero, or positive.');
    }
    if (request.action==='guess') {
      const last=state.history.at(-1);
      feedback(last.matched ? `Found λ = ${format(last.value)}. Nicely spotted.` : `No remaining eigenvalue within ±${state.config.epsilon} of ${format(last.guess)}. Try again.`,last.matched?'success':'miss');
      $('guess').value='';
    }
    if (request.action==='hint') feedback(`An eigenvector of an unfound eigenvalue is now visible. Hint cost: ${state.config.hint_cost} points.`);
    renderState();
    await draw();
    notice(`Current round: ε = ${state.config.epsilon} · ${state.config.guess_cost} points per guess · ${state.config.hint_cost} per hint${$('pending').hidden?'':' · Settings changes are pending.'}`);
    successful=true;
  } catch(error) {
    notice(error.message,true);
    if (state) $('layout').value=state.layout;
  } finally {
    $('loading').hidden=true;
    setBusy(false);
    if (successful && ['guess','new'].includes(request.action) && state.status==='playing') $('guess').focus({preventScroll:true});
  }
}
async function refreshDisplay() {
  if (busy || !state) return;
  setBusy(true);
  try { renderState(); await draw(); notice('Display updated. Your round is unchanged.'); }
  catch(error) { notice(error.message,true); }
  finally { setBusy(false); }
}
function validateSettings() {
  for (const id of Object.values(fields)) {
    const input=$(id);
    if (input.disabled || input.checkValidity()) continue;
    const dialog=input.closest('dialog');
    if (dialog && !dialog.open) dialog.showModal();
    input.reportValidity();
    return false;
  }
  return true;
}
function startRound() {
  updateModel();
  if (!validateSettings()) return;
  let layout=$('layout').value;
  if (layout==='geometric' && $('model').value!=='geometric') layout='spring';
  // New planar challenges get an embedding by default; other saved layouts are respected.
  if ($('model').value==='planar' && state?.config.model!=='planar') layout='planar';
  if (layout==='planar' && $('model').value!=='planar') layout='spring';
  act({action:'new',config:readConfig(),layout});
}
function rulesKey(config) { return JSON.stringify(Object.fromEntries(Object.entries(config).filter(([k])=>k!=='seed').sort(([a],[b])=>a.localeCompare(b)))); }
function loadRecords() {
  try { const value=JSON.parse(localStorage.getItem('spectrum-records-v1')||'[]'); return Array.isArray(value)?value.filter(r=>r && typeof r.name==='string' && Number.isFinite(r.score) && r.config && typeof r.model==='string').slice(0,100):[]; }
  catch(_) { return []; }
}
function showRecords() {
  let records=loadRecords();
  if ($('matchingRules').checked && state) records=records.filter(record=>rulesKey(record.config)===rulesKey(state.config));
  records.sort((a,b)=>b.score-a.score || a.attempts-b.attempts);
  $('recordsList').replaceChildren();
  if (!records.length) $('recordsList').append(el('p',{},'No completed rounds saved with these rules yet.'));
  records.forEach((record,i)=>{
    const row=el('div',{className:'record'}), description=el('div');
    description.append(el('strong',{},record.name),el('small',{},`${record.model} · N=${record.config.n} · ε=${record.config.epsilon} · ${record.attempts} guesses · ${record.hints} hints`));
    row.append(el('span',{className:'record-rank'},String(i+1)),description,el('span',{className:'record-score'},String(record.score)));
    row.title=`Seed ${record.config.seed}; ${JSON.stringify(record.config)}`;
    $('recordsList').append(row);
  });
}
$('saveScore').onclick=()=>{
  if (saved || state?.status!=='solved') return;
  try {
    const records=loadRecords();
    if (!records.some(r=>r.id===roundKey)) records.push({id:roundKey,name:$('playerName').value.trim().slice(0,24)||'Player',score:state.score,attempts:state.attempts,hints:state.hints,model:state.model_name,config:state.config,date:new Date().toISOString()});
    localStorage.setItem('spectrum-records-v1',JSON.stringify(records.slice(-100)));
    saved=true; $('saveScore').disabled=true; $('saveMessage').textContent='Saved on this browser.';
  } catch(_) { $('saveMessage').textContent='Browser storage is unavailable. This score could not be saved.'; }
};
$('copyChallenge').onclick=async()=>{
  if (!state) return;
  const url=new URL(location.href); url.hash='challenge='+btoa(JSON.stringify({config:state.config,layout:state.layout}));
  try { await navigator.clipboard.writeText(url.href); notice('Challenge link copied. It starts the same graph and rules in a new round.'); }
  catch(_) {
    const dialog=el('dialog'), heading=el('h2',{},'Copy your challenge link'), input=el('input',{readOnly:true,value:url.href}), close=el('button',{className:'primary'},'Done');
    close.onclick=()=>{dialog.close();dialog.remove();};
    dialog.append(heading,input,el('p',{},'Select and copy this link. A localhost link works only on this computer; use the published address to share with others.'),close);
    document.body.append(dialog);dialog.showModal();input.select();
  }
};
$('configForm').onsubmit=event=>{event.preventDefault();startRound();};
$('newGraph').onclick=startRound;
$('guessForm').onsubmit=event=>{event.preventDefault();if ($('guess').value.trim() && $('guess').checkValidity()) act({action:'guess',value:Number($('guess').value)});};
$('hintButton').onclick=()=>act({action:'hint'});
$('giveUp').onclick=()=>act({action:'give_up'});
$('clearVector').onclick=()=>act({action:'select',id:null});
$('layout').onchange=()=>act({action:'layout',layout:$('layout').value});
['renderer','labels','palette','nodeSize'].forEach(id=>$(id).onchange=refreshDisplay);
$('model').onchange=()=>{updateModel();pending();};
['n','connected'].forEach(id=>$(id).addEventListener('input',updateModel));
[...Object.values(fields),'connected'].forEach(id=>$(id).addEventListener('input',pending));
[['settingsButton','settingsDialog'],['displayButton','displayDialog'],['rulesButton','rulesDialog'],['recordsButton','recordsDialog']].forEach(([button,dialog])=>$(button).onclick=()=>{if(dialog==='recordsDialog')showRecords();$(dialog).showModal();});
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>$(button.dataset.close).close());
$('settingsDone').onclick=()=>{if(validateSettings())$('settingsDialog').close();};
$('matchingRules').onchange=showRecords;
$('graph').onpointerdown=event=>{
  if (busy) return;
  const node=event.target.closest('.node');
  if (!node) return;
  drag=Number(node.dataset.node); $('graph').setPointerCapture(event.pointerId);
};
$('graph').onpointermove=event=>{
  if (drag===null) return;
  const point=$('graph').createSVGPoint(); point.x=event.clientX; point.y=event.clientY;
  const transformed=point.matrixTransform($('graph').getScreenCTM().inverse());
  const x=Math.max(30,Math.min(870,transformed.x)), y=Math.max(30,Math.min(540,transformed.y));
  positions[drag]=[(x-450)/232,(280-y)/232]; drawSVG();
};
$('graph').onpointerup=$('graph').onpointercancel=()=>{drag=null;};
new ResizeObserver(()=>{if(state && $('renderer').value==='svg') drawSVG();}).observe($('graphStage'));
async function init() {
  updateModel();setBusy(true);
  let shared;
  try {
    const encoded=new URLSearchParams(location.hash.slice(1)).get('challenge');
    if (encoded && encoded.length<4000) { shared=JSON.parse(atob(encoded)); if (!shared.config) throw new Error(); applyConfig(shared.config); }
  } catch(_) { shared=null; notice('This challenge link is invalid. Starting a fresh round.',true); }
  try {
    backend=await makeBackend();
    setBusy(false);
    await act({action:'new',config:shared?.config||readConfig(),layout:shared?.layout||'spring'});
  } catch(error) {
    $('loadingText').textContent=error.message;
    $('loading').querySelector('.spinner').hidden=true;
    notice(error.message,true);
  }
}
init();
