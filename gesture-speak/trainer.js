// Gesture to speech, hands free. After Connect the page teaches itself: it asks for each
// gesture three times, one phrase after the other, with no buttons. Then it keeps
// recognising: every gesture is written down and spoken (ElevenLabs through this
// project's own server at /speak; the browser's voice if that does not answer).
// Built on the kit's gesture trainer (recogniser.js is the kit's, unchanged).
import { cloudFetch } from './cloud.js';
import { $, say, attempt, onConnect } from '../shared/page.js';
import { Segmenter, GYRO_SCALE } from './recogniser.js';
import { features, match, distance, rate, ShakeDetector, MIN_TURNS } from './rhythm.js';
import { MOTIONS } from './motions.js';
import { SCENES } from './scenes.js';
import { captions, browserCaptions } from './captions.js';
import { airDrawing } from './draw.js';
import { SHAPES, picture, FAR } from './shapes.js';
import { oggPackets } from '../vexo-open-kit/js/src/audio.js';

const GESTURES = document.querySelectorAll('input[id^="name-"]').length;   // rows in the table on the page
const COMMANDS = 4;              // shake rhythm: slow, fast, slow x2, fast x2
const EXAMPLES = 3;              // how many times you show each gesture
const SETTLE_MS = 1500;          // after a phrase is learned: time to bring the arm back, nothing counts
const PAUSE_MS = 1500;           // AI sentences: the hand still for this long ends the sentence
const RETRIES = 2;               // how often an odd example is thrown out before the row is taken as it is
const STORE = 'gesture-speak-v5';   // examples and phrases are kept in this browser, so a reload keeps them (v5: shapes end with the shake rate)
const LINES = { ax: '#ff5c5c', ay: '#5cd65c', az: '#5c9dff', gx: '#ffa13d', gy: '#c77dff', gz: '#3dd6d6' };

const segmenter = new Segmenter();
let examples = Array.from({ length: GESTURES }, () => []);   // one list of shapes per phrase

let band = null;
let recording = -1;              // the row being learned, or -1 = recognising
let ignoreUntil = 0;             // gestures before this moment (computer time) do not count
let retries = 0;                 // odd examples thrown out for the row being learned
let resting = null;              // timer that waits for the pretend hand to finish a motion
let nextTimer = null;            // waits a moment before the next phrase is asked for
const talk = [];                 // the conversation, newest last: { who: 'me' | 'them', text }
let live = '';                   // what the other person is saying right now (captions, not finished)
let talking = 0;                 // this page is speaking: the band's microphone is not sent, or it would caption us
let pending = [];                // AI sentences: the phrases of the sentence being made
let pauseTimer = null;

// ---- keeping the examples across a reload
function save() {
  const phrases = Array.from({ length: GESTURES }, (_, g) => $(`#name-${g}`).value);
  const rphrases = Array.from({ length: COMMANDS }, (_, i) => $(`#rname-${i}`).value);
  const dphrases = Object.fromEntries(SHAPES.map(({ key }) => [key, $(`#dname-${key}`).value]));
  localStorage.setItem(STORE, JSON.stringify({ examples, phrases, rphrases, dphrases, limit: $('#limit').value, scene: $('#scene').value,
    mode: $('#mode').value, boundary: $('#boundary').value, guessMode: $('#guess-mode').value, boardSize: $('#board-size').value }));
}
function load() {
  try {
    const kept = JSON.parse(localStorage.getItem(STORE));
    if (!kept || !Array.isArray(kept.examples)) return;
    for (let g = 0; g < GESTURES; g++) {
      const list = kept.examples[g];
      if (Array.isArray(list)) examples[g] = list.filter((s) => Array.isArray(s) && s.every(Number.isFinite)).slice(0, EXAMPLES);
      if (typeof kept.phrases?.[g] === 'string') $(`#name-${g}`).value = kept.phrases[g].slice(0, 60);
    }
    if (Number(kept.limit) >= 0.2 && Number(kept.limit) <= 2) $('#limit').value = kept.limit;
    if (kept.scene in SCENES) $('#scene').value = kept.scene;
    if (['rhythm', 'draw', 'taught'].includes(kept.mode)) $('#mode').value = kept.mode;
    if (['rest', 'all', 'off'].includes(kept.guessMode)) $('#guess-mode').value = kept.guessMode;
    if (Number(kept.boardSize) >= 40 && Number(kept.boardSize) <= 100) $('#board-size').value = kept.boardSize;
    for (const { key } of SHAPES) if (typeof kept.dphrases?.[key] === 'string') $(`#dname-${key}`).value = kept.dphrases[key].slice(0, 60);
    if (Number(kept.boundary) >= 2 && Number(kept.boundary) <= 6) $('#boundary').value = kept.boundary;
    for (let i = 0; i < COMMANDS; i++) if (typeof kept.rphrases?.[i] === 'string') $(`#rname-${i}`).value = kept.rphrases[i].slice(0, 60);
  } catch { /* nothing kept, or not ours: start empty */ }
}

// ---- the voice: ElevenLabs through /speak, one phrase after the other
const sounds = new Map();        // phrase -> Promise of a sound address (or null: use the browser's voice)
let line = Promise.resolve();    // what is being said now; the next phrase waits for it

function fetchSound(text) {
  if (!sounds.has(text)) {
    sounds.set(text, cloudFetch('/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
      .then((answer) => (answer.ok ? answer.blob() : null))
      .then((blob) => (blob ? URL.createObjectURL(blob) : null))
      .catch(() => null));
  }
  return sounds.get(text);
}

function browserVoice(text) {
  return new Promise((done) => {
    if (!('speechSynthesis' in window)) return done();
    const words = new SpeechSynthesisUtterance(text);
    words.onend = words.onerror = () => done();
    speechSynthesis.speak(words);
    setTimeout(done, 6000);      // never wait for ever
  });
}

function speak(text) {
  if (!text) return;
  const ready = fetchSound(text);                // starts at once, plays when its turn comes
  line = line.then(async () => {
    const address = await ready;
    $('#voice').textContent = address ? '(voice: ElevenLabs)' : '(voice: this browser; ElevenLabs did not answer)';
    talking++;
    try {
      if (!address) return await browserVoice(text);
      await new Promise((done) => {
        const sound = new Audio(address);
        sound.onended = sound.onerror = () => done();
        sound.play().catch(() => browserVoice(text).then(done));
        setTimeout(done, 8000);
      });
    } finally {
      setTimeout(() => talking--, 400);          // the room still echoes for a moment
    }
  });
}
/** Fetch every phrase now, so the first time a gesture is made the sound is there already. */
function warmVoice() {
  for (let g = 0; g < GESTURES; g++) fetchSound(nameOf(g));
  for (let i = 0; i < COMMANDS; i++) fetchSound(cmdPhrase(i));
  for (const { key } of SHAPES) fetchSound(shapePhrase(key));
}

// ---- the page
/** Long text gets smaller type, so the space it sits in stays the same size (theme.css reads --fit). */
function fit(element) {
  const letters = element.textContent.length;
  element.style.setProperty('--fit', letters <= 45 ? 1 : letters <= 90 ? 0.78 : letters <= 160 ? 0.62 : 0.5);
}
function show(text, detail = '', colour = '', sign = null) {
  $('#status').textContent = text;
  $('#status').style.color = colour;
  $('#board-said').textContent = text;            // shown under the board in full screen
  $('#board-said').style.color = colour;
  fit($('#board-said'));
  fit($('#status'));
  $('#detail').textContent = detail;
  $('#now-sign').hidden = sign === null;
  if (sign !== null) $('#now-sign').src = typeof sign === 'number' ? signOf(sign) : sign;     // a table row, or a picture
}
const nameOf = (g) => $(`#name-${g}`).value.trim() || `Phrase ${g + 1}`;
const signOf = (g) => $(`#name-${g}`).closest('tr').querySelector('img.sign').getAttribute('src');
const trained = () => examples.some((list) => list.length > 0);
const limit = () => Number($('#limit').value);
const skipped = new Set();     // phrases you skipped: left out until the next Connect
const nextToLearn = () => examples.findIndex((list, g) => list.length < EXAMPLES && !skipped.has(g));

function showTable() {
  for (let g = 0; g < GESTURES; g++) {
    $(`#count-${g}`).textContent = `${examples[g].length} of ${EXAMPLES}`;
    $(`#record-${g}`).textContent = recording === g ? 'Skip' : 'Redo';
    $(`#record-${g}`).disabled = !band;
  }
  $('#limit-text').textContent = limit().toFixed(2);
}

function waitForGesture() {
  if (isDraw()) return show('Make a fist and draw', `Open your hand when the shape is done.${band ? ' Shakes on the band work too.' : ''}`);
  if (isRhythm()) return show('Listening for shakes', 'Shake slow or fast, once or twice. Stop for a moment after each.');
  if (recording !== -1) {
    show(`Show me "${nameOf(recording)}"`, `${examples[recording].length + 1} of ${EXAMPLES}. Hold still, make the gesture, hold still again.`, '', recording);
  } else if (trained()) show('Listening', 'Make any gesture you taught. Hold still for a moment between two.');
  else show('Nothing learned', 'Press Redo next to a phrase to teach it.');
}

/** Start learning one phrase. Called by the page itself after Connect, and by Redo. */
function learn(g) {
  clearTimeout(nextTimer);
  recording = g;
  retries = 0;
  examples[g] = [];
  segmenter.reset();
  ignoreUntil = Date.now() + 600;
  light('#ffffff', { pattern: 'breathe', period: 1500 });    // white and breathing: "I am learning"
  save();
  showTable();
  waitForGesture();
}

/** Recognise from now on, or go on to the next phrase that still has to be learned. */
function carryOn() {
  clearTimeout(nextTimer);
  const next = nextToLearn();
  if (band && next !== -1 && modeIs('taught')) return learn(next);
  recording = -1;
  light(null);
  save();
  showTable();
  waitForGesture();
}

/** The example that does not look like the other two (an arm coming back to rest, a bump), or -1. */
function oddOne(list) {
  const near = list.map((one, i) => Math.min(...list.filter((_, j) => j !== i).map((other) => distance(one, other))));
  const worst = near.indexOf(Math.max(...near));
  const others = list.filter((_, i) => i !== worst);
  const between = distance(others[0], others[1]);
  return near[worst] > limit() && near[worst] > 2 * between ? worst : -1;
}

/** Draw the samples of one gesture: six lines over time. */
function draw(gesture) {
  const canvas = $('#picture');
  const pen = canvas.getContext('2d');
  const { width, height } = canvas;
  pen.clearRect(0, 0, width, height);
  if (!gesture) return;
  const start = gesture[0].t, length = gesture[gesture.length - 1].t - start;
  pen.lineWidth = 2;
  for (const [axis, colour] of Object.entries(LINES)) {
    const scale = axis[0] === 'g' ? GYRO_SCALE * 2 : 2;
    pen.strokeStyle = colour;
    pen.beginPath();
    for (const sample of gesture) {
      pen.lineTo(10 + ((sample.t - start) / length) * (width - 20), height / 2 - (sample[axis] / scale) * (height / 2 - 8));
    }
    pen.stroke();
  }
}

function showSpoken() {
  const lines = talk.slice(-40).map(({ who, text }) => line_(who, text));
  if (pending.length) lines.push(line_('me', `${pending.join(' + ')} ...`, true));
  if (live) lines.push(line_('them', live, true));
  if (!lines.length) lines.push(line_('', 'Nothing yet.'));
  $('#spoken').replaceChildren(...lines);
  $('#spoken').scrollTop = $('#spoken').scrollHeight;
  $('#live').textContent = live || (talk.findLast((one) => one.who === 'them')?.text ?? '');
  $('#live').classList.toggle('guess', Boolean(live));
  $('#board-caption').textContent = $('#live').textContent;   // shown over the board in full screen
  fit($('#live'));
  fit($('#board-caption'));
  $('#live').scrollTop = $('#live').scrollHeight;             // the newest words are the ones in view
}
function line_(who, text, guess = false) {
  const p = document.createElement('p');
  p.className = `${who}${guess ? ' guess' : ''}`;
  if (who) {
    const name = document.createElement('b');
    name.textContent = who === 'me' ? 'Me' : 'Them';
    p.append(name, ' ');
  }
  p.append(text);
  return p;
}

/** One recognised phrase: said at once, or kept until the sentence is over when AI sentences is on. */
function heard(phrase) {
  if (!$('#ai').checked) {
    speak(phrase);
    talk.push({ who: 'me', text: phrase });
    return showSpoken();
  }
  pending.push(phrase);
  fetchSound(phrase);                            // ready in case it stays a sentence of one
  showSpoken();
  clearTimeout(pauseTimer);
  pauseTimer = setTimeout(endSentence, PAUSE_MS);
}

/** The hand paused: turn the phrases so far into one sentence (OpenAI through /sentence) and say it. */
async function endSentence() {
  clearTimeout(pauseTimer);
  const phrases = pending;
  pending = [];
  if (phrases.length === 0) return;
  let text = phrases.join(' ');                  // one phrase, or no answer: said as it is
  if (phrases.length > 1) {
    try {
      const answer = await cloudFetch('/sentence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phrases }) });
      if (answer.ok) text = (await answer.json()).text || text;
    } catch { /* said as it is */ }
  }
  speak(text);
  talk.push({ who: 'me', text });
  showSpoken();
}

function onGesture(gesture) {
  if (Date.now() < ignoreUntil) return;
  draw(gesture);
  if (!modeIs('taught')) return;                // shakes are found in the stream: see ShakeDetector
  const shape = features(gesture);
  const seconds = ((gesture[gesture.length - 1].t - gesture[0].t) / 1000).toFixed(1);
  if (recording !== -1) {
    const g = recording;
    examples[g].push(shape);
    if (examples[g].length === EXAMPLES) {
      const odd = retries < RETRIES ? oddOne(examples[g]) : -1;
      if (odd !== -1) {
        retries++;
        examples[g].splice(odd, 1);
        show(`Once more: "${nameOf(g)}"`, 'One of the three looked different from the other two, so it was dropped.', '', g);
      } else {
        const colour = $(`#colour-${g}`).value;
        show(`Learned "${nameOf(g)}"`, 'Bring your arm back to rest.', colour, g);
        light(colour);
        recording = -1;
        ignoreUntil = Date.now() + SETTLE_MS;
        clearTimeout(nextTimer);
        nextTimer = setTimeout(carryOn, SETTLE_MS);
      }
    } else {
      waitForGesture();
    }
    save();
    showTable();
    return;
  }
  if (!trained()) return;
  const candidates = examples.flatMap((list, g) => list.map((one) => ({ label: g, shape: one })));
  const found = match(shape, candidates, limit());
  const detail = `${seconds} seconds, ${rate(gesture).toFixed(1)} shakes a second. Distance to the nearest example: ${found.distance.toFixed(2)} (not sure above ${limit().toFixed(2)}).`;
  if (found.label === null) {
    show('Not sure', detail);
    light(null);
  } else {
    const colour = $(`#colour-${found.label}`).value;
    const phrase = nameOf(found.label);
    show(phrase, detail, colour, found.label);
    heard(phrase);
    followScript(found.label);
    light(colour);
  }
}

// ---- scenes: ready-made phrase sets, some with a script to act out in a demo
let step = 0;                    // the script line being acted out now
const scene = () => SCENES[$('#scene').value];

/** What a script line asks for: its picture, and what you say (or what to do). */
function lineView(line) {
  if (line.ai) return { src: AI_PICTURE, alt: 'Draw anything', you: line.hint };
  if (line.shape) return { src: shapePicture(line.shape), alt: shapeOf(line.shape).name, you: shapePhrase(line.shape) };
  if (line.cmd !== undefined) {
    return { src: cmdPicture(line.cmd), alt: RHYTHM_NAMES[line.cmd],
      you: isDraw() ? `${RHYTHM_NAMES[line.cmd]} on the band: ${cmdPhrase(line.cmd)}` : cmdPhrase(line.cmd) };
  }
  return { src: signOf(line.row), alt: $(`#name-${line.row}`).closest('tr').querySelector('img.sign').alt, you: nameOf(line.row) };
}
const answers = (line, key) => (line.ai ? key === 'ai' : (line.shape ?? line.cmd ?? line.row) === key);
const scriptLines = () => (isDraw() ? scene()?.draw?.script : isRhythm() ? scene()?.rhythm?.script : scene()?.script);
function showScript() {
  const script = scriptLines();
  $('#script-card').hidden = !script;
  if (!script) return;
  $('#script-title').textContent = `Demo script: ${scene().title}`;
  $('#script').replaceChildren(...script.map((line, i) => {
    const item = document.createElement('li');
    item.className = i < step ? 'done' : i === step ? 'now' : '';
    const sign = document.createElement('img');
    sign.className = 'sign';
    const view = lineView(line);
    sign.src = view.src;
    sign.alt = view.alt;
    const they = document.createElement('span');
    they.className = 'they';
    they.textContent = line.they;
    const you = document.createElement('span');
    you.className = 'you';
    you.textContent = view.you;
    item.append(they, sign, you);
    return item;
  }));
}
/** A phrase was recognised: if it answers the current script line, go on to the next. */
function followScript(key) {
  const script = scriptLines();
  if (!script || step >= script.length || !answers(script[step], key)) return;
  step++;
  showScript();
}
/** Fill the phrase boxes from the scene. The learned gestures stay: only the words change. */
function useScene() {
  scene().phrases.forEach((phrase, g) => { if (g < GESTURES) $(`#name-${g}`).value = phrase; });
  scene().rhythm?.phrases.forEach((phrase, i) => { $(`#rname-${i}`).value = phrase; });
  for (const [key, phrase] of Object.entries(scene().draw?.phrases ?? {})) $(`#dname-${key}`).value = phrase;
  step = 0;
  save();
  warmVoice();
  showScript();
}

// ---- shake rhythm: nothing to teach
// Four commands, told apart by speed (slow or fast, the line is the slider) and by how many
// bursts (one, or two with a short stop between). A burst waits GAP_MS for a second one.
const RHYTHM_NAMES = ['Slow shake', 'Fast shake', 'Slow shake ×2', 'Fast shake ×2'];
const RHYTHM_COLOURS = ['#0a84ff', '#ff9500', '#0a84ff', '#ff9500'];
const GAP_MS = 900;              // after a burst: this long to start a second one
const MOST_WAIT_MS = 4000;       // a second burst that never ends: the first is said anyway
const METER_TOP = 9;             // shakes a second at the right end of the meter
const modeIs = (mode) => $('#mode').value === mode;
const isRhythm = () => modeIs('rhythm');
const isDraw = () => modeIs('draw');
const boundary = () => Number($('#boundary').value);
const cmdPhrase = (i) => $(`#rname-${i}`).value.trim() || RHYTHM_NAMES[i];
const cmdPicture = (i) => $(`#tile-${i} img`).getAttribute('src');
let held = null;                 // { fast, detail, since }: a burst waiting to see if a second one comes
let holdTimer = null;
let meterAt = 0;

const detector = new ShakeDetector();
let samplesThisSecond = 0;       // motion samples from the band, counted for the "is it streaming" line

/** A burst of turning has ended (from ShakeDetector). */
function onShake(shake) {
  if (isDraw() && air.busy) return;            // the wrist moved because it was drawing, not shaking
  if (shake.turns < MIN_TURNS) return show('Not a shake', `Only ${shake.turns} turn${shake.turns === 1 ? '' : 's'}. Turn the wrist left and right a few times, then stop.`);
  const fast = shake.perSecond >= boundary();
  const detail = `${shake.perSecond.toFixed(1)} shakes a second, ${fast ? 'fast' : 'slow'} (the line is at ${boundary()}).`;
  if (held && held.fast === fast) {          // the second burst, same speed: x2
    held = null;
    return said(fast ? 3 : 2, detail);
  }
  if (held) said(held.fast ? 1 : 0, held.detail);   // a different speed: the first one stands on its own
  held = { fast, detail, since: Date.now() };
  const i = fast ? 1 : 0;
  show(`${RHYTHM_NAMES[i]}...`, `${detail} Shake the same way again now for ×2.`, RHYTHM_COLOURS[i], cmdPicture(i));
  clearTimeout(holdTimer);
  holdTimer = setTimeout(waitForSecond, GAP_MS);
}
function waitForSecond() {
  if (!held) return;
  // A second burst is under way: wait for it to end (it decides x1 or x2).
  if (detector.busy && Date.now() - held.since < MOST_WAIT_MS) { holdTimer = setTimeout(waitForSecond, 100); return; }
  const one = held;
  held = null;
  said(one.fast ? 1 : 0, one.detail);
}
function said(i, detail) {
  clearTimeout(holdTimer);
  // An AI guess is waiting: a slow shake says it, a fast shake drops it.
  if (guessed && i === 0) return sayGuess();
  if (guessed && i === 1) return dropGuess();
  const phrase = cmdPhrase(i);
  show(phrase, `${RHYTHM_NAMES[i]}. ${detail}`, RHYTHM_COLOURS[i], cmdPicture(i));
  heard(phrase);
  followScript(i);
  light(RHYTHM_COLOURS[i]);
  const tile = $(`#tile-${i}`);
  tile.classList.add('hit');
  setTimeout(() => tile.classList.remove('hit'), 1500);
}
function showMeter(perSecond) {
  $('#needle').style.left = `${(Math.min(perSecond, METER_TOP) / METER_TOP) * 100}%`;
  $('#meter-text').textContent = perSecond > 0
    ? `${perSecond.toFixed(1)} shakes a second: ${perSecond >= boundary() ? 'FAST' : 'slow'}` : 'not shaking';
}
function showBoundary() {
  $('#meter-slow').style.width = `${(boundary() / METER_TOP) * 100}%`;
  $('#boundary-text').textContent = String(boundary());
}
function showMode() {
  $('#draw-card').hidden = !isDraw();
  $('#rhythm-card').hidden = modeIs('taught');   // shakes work while drawing too
  $('#taught-card').hidden = !modeIs('taught');
  if (!isDraw() && air.on) air.stop();
  if (isDraw() && !air.on) air.start();          // drawing needs the camera: ask for it at once, no button to find
  held = null;
  clearTimeout(holdTimer);
  step = 0;
  showScript();
}

// ---- drawing in the air: a fist draws, an open hand finishes, the shape says a phrase
const shapeOf = (key) => SHAPES.find((one) => one.key === key);
const shapePhrase = (key) => $(`#dname-${key}`).value.trim() || shapeOf(key).name;
const shapePicture = (key) => `data:image/svg+xml,${encodeURIComponent(picture(key))}`;
const CAMERA_STATES = {
  loading: 'Loading the hand model (about 8 MB, once)...',
  on: 'Camera on. Make a fist to draw, open your hand to finish.',
  off: 'Camera off.',
  'no-model': 'The hand model could not be loaded (it needs the internet once). Draw with the mouse meanwhile.',
  denied: 'The browser may not use the camera. Allow it with the icon in the address bar, then press Start camera again.',
  'no-camera': 'No camera found. Draw with the mouse or a finger on the picture.',
};
const AI_PICTURE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72" width="72" height="72">'
  + '<rect width="72" height="72" rx="10" fill="#fff"/><text x="36" y="46" text-anchor="middle" font-family="system-ui,sans-serif" '
  + 'font-size="28" font-weight="700" fill="#e5446d">AI ?</text></svg>')}`;
const GUESS_MS = 20000;          // a guess nobody confirms is dropped after this long
let guessed = null;              // { drawing, say, picture }: the AI's guess, waiting for a yes
let guessTimer = 0;

/** A drawing is finished: a simple shape says its phrase; anything else goes to the AI (see the select). */
function drew(result, picture) {
  // While a guess waits: a check says it, a line drops it.
  if (guessed && result.sure && result.key === 'check') return sayGuess();
  if (guessed && result.sure && result.key === 'line') return dropGuess();
  if (guessed) dropGuess(true);
  const asking = $('#guess-mode').value;
  if (asking === 'all' || (asking === 'rest' && !result.sure)) return askAI(picture());
  const shape = shapeOf(result.key);
  if (!result.sure) {
    return show('Not sure', `Closest: ${shape.name}, then ${shapeOf(result.nextKey).name}. Draw it again, a little bigger and slower.`,
      '', shapePicture(result.key));
  }
  const phrase = shapePhrase(result.key);
  show(phrase, `${shape.name} (distance ${result.distance.toFixed(2)}, sure below ${FAR}).`, '#e5446d', shapePicture(result.key));
  heard(phrase);
  followScript(result.key);
  light('#e5446d');
  const tile = $(`#shape-${result.key}`);
  tile.classList.add('hit');
  setTimeout(() => tile.classList.remove('hit'), 1500);
}

/** The last lines of the conversation, with what the other person is saying right now (not finished yet) at the end. */
function heardSoFar() {
  const lines = talk.slice(-8);
  if (live) lines.push({ who: 'them', text: live });
  return lines;
}

/** Ask the AI what the drawing means (OpenAI through /guess). Nothing is said until you confirm. */
async function askAI(picture) {
  show('Guessing...', 'The AI is looking at your drawing.', '', picture);
  light('#ffd60a', { pattern: 'breathe', period: 800 });
  let answer;
  try {
    const reply = await cloudFetch('/guess', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: picture, scene: scene()?.title ?? 'an everyday conversation', history: heardSoFar() }) });
    if (reply.status === 503) {
      light(null);
      return show('AI guessing is off', 'It needs OPENAI_API_KEY in the .env file next to server.py (restart the server after). Simple shapes work meanwhile.', '', picture);
    }
    if (!reply.ok) throw new Error();
    answer = await reply.json();
  } catch {
    light(null);
    return show('Could not guess', 'The AI did not answer. Draw again, or use a simple shape.', '', picture);
  }
  if (!answer.say) {
    light(null);
    const what = answer.drawing && answer.drawing !== 'unclear' ? ` It looks like ${answer.drawing}.` : '';
    return show('Not sure', `The AI could not tell what you want to say.${what} Draw it again.`, '', picture);
  }
  guessed = { ...answer, picture };
  if ($('#say-at-once').checked) return sayGuess();     // said straight after the drawing, no yes or no
  $('#guess-text').textContent = `You drew ${answer.drawing}: "${answer.say}"`;
  $('#guess').hidden = false;
  show(`"${answer.say}"?`, `The AI thinks you drew ${answer.drawing}. Say it: draw a check, shake the band slowly, or press Say it. `
    + 'Drop it: draw a line, shake fast, or press No.', '#b8860b', picture);
  light('#ffd60a', { pattern: 'blink', period: 600 });   // yellow, blinking: "yes or no?"
  clearTimeout(guessTimer);
  guessTimer = setTimeout(() => dropGuess(), GUESS_MS);
}
function sayGuess() {
  const guess = guessed;
  dropGuess(true);
  show(guess.say, `The AI's guess: ${guess.drawing}.`, '#e5446d', guess.picture);
  heard(guess.say);
  followScript('ai');
  light('#e5446d');
}
function dropGuess(quietly = false) {
  if (!guessed) return;
  guessed = null;
  clearTimeout(guessTimer);
  $('#guess').hidden = true;
  if (quietly) return;
  show('Dropped', 'Nothing was said. Draw again.');
  light(null);
}
// Hand signs the camera knows by itself, and what each one says (the phrase can be changed on the page).
const SIGN_NAMES = {
  Thumb_Up: { face: '👍', name: 'Thumbs up', phrase: 'Yes' },
  Thumb_Down: { face: '👎', name: 'Thumbs down', phrase: 'No' },
  Victory: { face: '✌️', name: 'Two fingers', phrase: 'Thank you' },
  Pointing_Up: { face: '☝️', name: 'One finger up', phrase: 'Excuse me, one moment please.' },
  ILoveYou: { face: '🤟', name: 'I love you', phrase: 'I love you' },
};
const signPhrase = (name) => $(`#sname-${name}`).value.trim() || SIGN_NAMES[name].phrase;
let penDown = false;             // the fist is closed and a line is being drawn
const air = airDrawing({
  video: $('#video'),
  ink: $('#ink'),
  onShape: drew,
  onState(state) {
    $('#camera-state').textContent = CAMERA_STATES[state];
    $('#camera').textContent = state === 'on' || state === 'loading' ? 'Stop camera' : 'Start camera';
  },
  onSign(name) {
    const phrase = signPhrase(name);
    show(phrase, `Hand sign: ${SIGN_NAMES[name].name}.`, '#e5446d');
    heard(phrase);
    light('#e5446d');
    const tile = $(`#sign-${name}`);
    tile.classList.add('hit');
    setTimeout(() => tile.classList.remove('hit'), 1500);
  },
  onHand(state) {
    if (penDown) return;
    $('#pen-state').textContent = state === 'open' ? 'Open hand: not drawing' : state === 'between' ? 'Half open: make a fist to draw' : '';
  },
  onPen(down) {
    penDown = down;
    $('#pen-state').textContent = down ? 'Fist: drawing...' : '';
    if (down) light('#e5446d', { pattern: 'breathe', period: 900 });   // pink, breathing: "I am drawing"
  },
});

// ---- live captions: the other person's words, from the band's microphone
let micOn = false;               // the band's microphone is on: its light is solid blue and cannot be changed
let voice = null;                // the pretend band's sample voice, loaded once
/** The band's light, unless the microphone owns it. null = off. */
function light(colour, options) {
  if (!band || micOn) return;
  attempt(colour === null ? band.ledOff() : band.setLed(colour, options));
}
// Two ways to hear the other person. With a Deepgram key: the band's microphone, through
// Deepgram. Without one (or with no band connected): this computer's microphone, through the
// browser's own speech recognition, so captions always work at once.
const BAND_STATES = {
  connecting: 'Connecting to Deepgram...',
  on: "Captions on, from the band's microphone. Everything it hears is sent to Deepgram until you switch them off.",
  off: 'Captions off.',
  failed: 'Deepgram stopped answering. Switch captions on again.',
};
const COMPUTER_STATES = {
  on: "Captions on, from this computer's microphone (Chrome's own speech recognition; the sound goes to Google). "
    + "For the band's microphone, put DEEPGRAM_API_KEY in .env.",
  off: 'Captions off.',
  unsupported: 'This browser has no speech recognition of its own. Open the page in Chrome, or put DEEPGRAM_API_KEY in .env.',
  denied: 'The browser may not use the microphone. Allow it with the icon in the address bar, then switch captions on again.',
  failed: "Chrome's speech recognition did not answer (it needs the internet). Switch captions on again.",
};
function caption(text, final) {
  if (final) { live = ''; talk.push({ who: 'them', text }); } else live = text;
  showSpoken();
}
async function captionState(text, on, ended) {
  $('#captions-state').textContent = text;
  $('#captions-state').classList.toggle('warn', on);
  if (!ended) return;
  $('#captions').checked = false;
  live = '';
  showSpoken();
  await mic(false);
}
const listener = captions({
  text: caption,
  async state(state) {
    // No key, or no server to ask for one: this computer's microphone instead.
    // Deepgram stopped or never answered: the same, so the other person's words never just go missing.
    if (state === 'no-key' || state === 'no-token' || state === 'failed') { await mic(false); return computer.start(); }
    await captionState(BAND_STATES[state], state === 'on', state !== 'on' && state !== 'connecting');
  },
});
const computer = browserCaptions({
  text: caption,
  state: (state) => captionState(COMPUTER_STATES[state], state === 'on', state !== 'on'),
}, () => talking > 0);
async function mic(on) {
  if (!band || micOn === on) return;
  micOn = on;
  try { await band.configure({ audio: on }); } catch (e) { say(e.message); }
}
async function switchCaptions() {
  if (!$('#captions').checked) { listener.stop(); computer.stop(); return; }
  if (!band) return computer.start();            // no band: this computer's microphone
  await mic(true);
  listener.start();
}

// ---- the parts of the page that work without a band
for (const [key, { title }] of Object.entries(SCENES)) $('#scene').add(new Option(title, key));
// The shape tiles: a picture, the phrase it says, and Hear it.
for (const [key, sign] of Object.entries(SIGN_NAMES)) {
  const tile = document.createElement('div');
  tile.className = 'shape';
  tile.id = `sign-${key}`;
  const face = Object.assign(document.createElement('span'), { className: 'face', textContent: sign.face });
  const words = document.createElement('div');
  const title = Object.assign(document.createElement('b'), { textContent: sign.name });
  const row = document.createElement('p');
  row.className = 'row';
  const input = Object.assign(document.createElement('input'), { id: `sname-${key}`, maxLength: 60, value: sign.phrase });
  input.setAttribute('aria-label', `Phrase for ${sign.name}`);
  input.onchange = () => fetchSound(signPhrase(key));
  const hear = Object.assign(document.createElement('button'), { textContent: 'Hear it' });
  hear.onclick = () => speak(signPhrase(key));
  row.append(input, hear);
  words.append(title, row);
  tile.append(face, words);
  $('#sign-tiles').append(tile);
}
for (const shape of SHAPES) {
  const tile = document.createElement('div');
  tile.className = 'shape';
  tile.id = `shape-${shape.key}`;
  tile.innerHTML = picture(shape.key, 64);
  const words = document.createElement('div');
  const title = document.createElement('b');
  title.textContent = shape.name;
  const how = document.createElement('span');
  how.className = 'soft';
  how.textContent = ` ${shape.how}`;
  const row = document.createElement('p');
  row.className = 'row';
  const input = Object.assign(document.createElement('input'), { id: `dname-${shape.key}`, maxLength: 60 });
  input.setAttribute('aria-label', `Phrase for ${shape.name}`);
  input.value = SCENES.basic.draw.phrases[shape.key];
  input.onchange = () => { save(); fetchSound(shapePhrase(shape.key)); showScript(); };
  const hear = Object.assign(document.createElement('button'), { textContent: 'Hear it' });
  hear.onclick = () => speak(shapePhrase(shape.key));
  row.append(input, hear);
  words.append(title, how, row);
  tile.append(words);
  $('#shape-tiles').append(tile);
}
$('#camera').onclick = () => (air.on ? air.stop() : air.start());
// A bigger board: the slider, or the whole screen (Esc leaves it).
const boardSize = () => $('#board').style.setProperty('--board-size', `${$('#board-size').value}%`);
$('#board-size').oninput = () => { boardSize(); save(); };
// Where the browser does not allow full screen, the board fills the window instead (.full).
const isBig = () => Boolean(document.fullscreenElement) || $('#board').classList.contains('full');
function showBig() { $('#board-full').textContent = isBig() ? 'Leave full screen' : 'Full screen'; }
function leaveBig() {
  $('#board').classList.remove('full');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  showBig();
}
$('#board-full').onclick = () => {
  if (isBig()) return leaveBig();
  // Some browsers refuse full screen, some never answer at all: if it has not happened
  // within a moment, fill the window instead.
  const fill = () => { if (!document.fullscreenElement) { $('#board').classList.add('full'); showBig(); } };
  try { $('#board').requestFullscreen().catch(fill); } catch { fill(); }
  setTimeout(fill, 400);
};
$('#board-exit').onclick = leaveBig;
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) $('#board').classList.remove('full');   // the real thing came after all
  showBig();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && $('#board').classList.contains('full')) leaveBig(); });
$('#guess-yes').onclick = () => guessed && sayGuess();
$('#guess-no').onclick = () => dropGuess();
$('#guess-mode').onchange = () => { dropGuess(true); save(); };

// Once a second: is motion arriving from the band at all?
setInterval(() => {
  $('#motion-rate').textContent = !band ? 'Band not connected.'
    : samplesThisSecond ? `The band is sending ${samplesThisSecond} motion samples a second.`
      : 'No motion is arriving from the band. Disconnect and connect again.';
  $('#motion-rate').classList.toggle('warn', Boolean(band) && !samplesThisSecond);
  samplesThisSecond = 0;
}, 1000);
load();
// One way of working, nothing to choose: hand signs, drawing in the air and shakes on the band all at once.
$('#mode').value = 'draw';
$('#guess-mode').value = 'rest';
boardSize();
showBoundary();
showMode();
showMeter(0);
showTable();
for (let g = 0; g < GESTURES; g++) {
  $(`#speak-${g}`).onclick = () => speak(nameOf(g));
  $(`#name-${g}`).onchange = () => { save(); fetchSound(nameOf(g)); showScript(); };
}
$('#limit').oninput = () => { showTable(); save(); };
$('#scene').onchange = useScene;
$('#mode').onchange = () => { showMode(); save(); if (band) carryOn(); else waitForGesture(); };
$('#boundary').oninput = () => { showBoundary(); save(); };
for (let i = 0; i < COMMANDS; i++) {
  $(`#rspeak-${i}`).onclick = () => speak(cmdPhrase(i));
  $(`#rname-${i}`).onchange = () => { save(); fetchSound(cmdPhrase(i)); showScript(); };
}
$('#script-restart').onclick = () => { step = 0; showScript(); };
// The page shows only the conversation and the board. Everything else (phrases, shakes, scenes) is one button away.
$('#more').onclick = () => {
  const open = document.body.classList.toggle('more');
  $('#more').textContent = open ? 'Fewer options' : 'More options';
  $('#more').setAttribute('aria-expanded', String(open));
};
$('#clear').onclick = () => { talk.length = 0; live = ''; pending = []; clearTimeout(pauseTimer); showSpoken(); };
$('#captions').onchange = switchCaptions;
// A conversation goes both ways from the first second: captions are on as soon as the page opens
// (this computer's microphone until the band is connected, then the band's). ...?captions=0 leaves them off.
const autoCaptions = new URLSearchParams(location.search).get('captions') !== '0';
if (autoCaptions) { $('#captions').checked = true; switchCaptions(); }
$('#ai').onchange = () => { if (!$('#ai').checked) endSentence(); };
$('#forget').onclick = () => {
  examples = Array.from({ length: GESTURES }, () => []);
  save();
  skipped.clear();
  if (band) carryOn(); else showTable();      // connected: it starts teaching itself again
};

onConnect(async (theBand, pretend) => {
  band = theBand;
  band.on('motion', (sample) => {
    const gesture = segmenter.feed(sample);
    // The hand is moving: the sentence is not over, whatever this movement turns out to be.
    if (pending.length && segmenter.samples.length) { clearTimeout(pauseTimer); pauseTimer = setTimeout(endSentence, PAUSE_MS); }
    if (gesture) onGesture(gesture);
    samplesThisSecond++;
    if (isDraw()) air.motion(Math.hypot(sample.gx, sample.gy, sample.gz) > 40);   // the band helps the camera
    if (!modeIs('taught')) {
      const burst = detector.feed(sample);
      if (burst) onShake(burst);
      if (Date.now() - meterAt > 100) { meterAt = Date.now(); showMeter(detector.live()); }
    }
  });
  band.on('audio', (packet) => { if (!talking) listener.send(packet.opus); });

  const stop = (text) => { segmenter.reset(); clearTimeout(nextTimer); recording = -1; showTable(); show(text); };
  band.on('reconnecting', () => { detector.reset(); stop('Link lost...'); });
  band.on('reconnected', () => carryOn());
  band.on('disconnect', () => {
    if ($('#captions').checked && !computer.on) listener.stop();   // the computer's microphone goes on without the band
    if (autoCaptions && !computer.on) { $('#captions').checked = true; computer.start(); }   // keep listening without the band
    micOn = false;
    held = null;
    detector.reset();
    clearTimeout(holdTimer);
    showMeter(0);
    $('#pretend-voice').disabled = true;
    band = null;
    stop('Not connected');
    clearInterval(resting);
    for (const name of Object.keys(MOTIONS)) $(`#pretend-${name}`).disabled = true;
  });

  // Redo teaches one phrase again. While that phrase is being learned the button says Skip.
  for (let g = 0; g < GESTURES; g++) {
    $(`#record-${g}`).onclick = () => {
      if (recording !== g) { skipped.delete(g); return learn(g); }
      examples[g] = [];              // skipped: this phrase matches nothing, the page goes on to the next
      skipped.add(g);
      carryOn();
    };
  }
  if (pretend) {
    const buttons = (on) => { for (const name of Object.keys(MOTIONS)) $(`#pretend-${name}`).disabled = !on; };
    pretend.playMotion([{}]);
    for (const [name, [shape, seconds]] of Object.entries(MOTIONS)) {
      $(`#pretend-${name}`).onclick = () => {
        pretend.playMotion(shape, { seconds });
        pretend.playMotion({}, { seconds: 0.5 });
        buttons(false);
        clearInterval(resting);
        resting = setInterval(() => { if (!pretend.moving) { clearInterval(resting); buttons(Boolean(band)); } }, 50);
      };
    }
    buttons(true);
    // Someone speaks to you: the kit's sample voice, played through the pretend microphone.
    $('#pretend-voice').disabled = false;
    $('#pretend-voice').onclick = async () => {
      voice ??= fetch('../vexo-open-kit/dashboard/speech/sample-speech.opus').then((r) => r.arrayBuffer()).then((b) => oggPackets(new Uint8Array(b)));
      const packets = await voice;
      pretend.playLoudness(0.75, { seconds: packets.length * 0.02, packets });
    };
  }

  await band.configure({ motion: 50 });
  say(`Connected to ${band.name}.`);
  warmVoice();
  skipped.clear();
  carryOn();
  // The band is here: its microphone takes over the captions from the computer's.
  if (autoCaptions) { computer.stop(); $('#captions').checked = true; await switchCaptions(); }
});
