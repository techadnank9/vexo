// Drawing in the air: the computer's camera watches the hand. Make a fist and the pen is
// down: the fist's path is drawn on the screen. Open the hand and the drawing is done: it is
// recognised (shapes.js) and handed to the page. The mouse or a finger on the picture draws
// the same way, for a computer without a camera.
//
// The hand is found by Google's MediaPipe gesture recogniser, running inside this page
// (WebAssembly). The camera picture never leaves the computer; only the library and the
// model are downloaded, once, when the camera is switched on.
import { recognise } from './shapes.js';

const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
// Fist or open hand, measured on the finger joints themselves (not only the model's label):
// how far each fingertip reaches from the wrist, compared with its own knuckle. A straight
// finger reaches about 1.8 times as far as the knuckle, a finger curled into a fist under 1.
const CURLED = 1.2;              // a fingertip reaching less than this is curled
const STRAIGHT = 1.5;            // one reaching more than this is straight
const OPEN_FRAMES = 2;           // the hand seen open this many frames in a row: the pen lifts at once
// Hand signs: a hand shape held still says its phrase, no drawing needed. These are the
// shapes Google's model names by itself (a fist draws and an open hand stops, so they are not signs).
export const SIGNS = ['Thumb_Up', 'Thumb_Down', 'Victory', 'Pointing_Up', 'ILoveYou'];
const SIGN_FRAMES = 10;          // the same sign this many frames in a row (about a third of a second): it counts
const SIGN_GONE = 6;             // frames without it before the same sign can be said again
const LIFT_FRAMES = 3;           // frames without a fist before the pen lifts (a blur can hide the fist for a frame)
const DONE_MS = 450;             // the hand open this long: the drawing is finished
const MIN_SIZE = 0.12;           // a drawing smaller than this part of the picture is a twitch, not a shape
const SMOOTH = 0.45;             // how much of each new hand position is taken (the rest is the old one)
const SHOW_MS = 1600;            // a finished drawing stays on the screen this long
// With the band connected it helps the camera: a fast hand blurs, the camera loses the fist
// for a few frames, but the band still feels the wrist moving, so the line does not break.
// And the band feels when the hand has stopped: holding the fist still finishes the drawing.
const BAND_MOVING_MS = 250;      // the band moved this recently: the hand is still drawing
const BAND_STILL_MS = 700;       // the band still this long with the fist closed: the drawing is done
const BUSY_MS = 800;             // after the pen lifts, this long still counts as drawing (for the shakes)

/**
 * @param {object} page
 * @param {HTMLVideoElement} page.video
 * @param {HTMLCanvasElement} page.ink   drawn on top of the video
 * @param {(result: object, picture: () => string) => void} page.onShape   recognise()'s answer for a finished
 *   drawing, and a function that gives the drawing as a PNG (a data address), for the AI to look at
 * @param {(state: string) => void} page.onState    'loading' | 'on' | 'off' | 'no-model' | 'denied' | 'no-camera'
 * @param {(pen: boolean) => void} [page.onPen]
 */
export function airDrawing({ video, ink, onShape, onState, onPen = () => {}, onHand = () => {}, onSign = () => {} }) {
  let strokes = [];              // [[{x, y}]] from 0 to 1 across the picture
  let pen = false;
  let noFist = 0;                // frames in a row without a fist
  let openFrames = 0;            // frames in a row with the hand clearly open
  let sign = null, signFrames = 0, signGone = 0, signSaid = null;   // the hand sign being held
  let openSince = 0;             // when the pen was last lifted (ms)
  let hand = null;               // where the hand is now, for the marker: { x, y, fist }
  let smooth = null;
  let recogniser = null;
  let stream = null;
  let running = false;
  let fading = 0;
  let done = false;               // the drawing on the screen has been recognised already
  let mouseTimer = 0;
  let bandOn = false;            // motion has come from the band
  let bandMovedAt = -Infinity;   // when the band last felt the wrist moving (ms)
  let waitOpen = false;          // finished by holding still: wait for the hand to open or move before drawing again
  let lastPenAt = -Infinity;

  const pen2d = ink.getContext('2d');
  function paint() {
    const { width, height } = ink;
    // A white board over the whole picture: the camera picture underneath is never seen.
    pen2d.fillStyle = '#fff';
    pen2d.fillRect(0, 0, width, height);
    const unit = width / 640;            // lines keep their look at any board size
    pen2d.lineWidth = 8 * unit;
    pen2d.lineCap = pen2d.lineJoin = 'round';
    pen2d.strokeStyle = '#e5446d';
    for (const stroke of strokes) {
      pen2d.beginPath();
      stroke.forEach((p, i) => (i ? pen2d.lineTo(p.x * width, p.y * height) : pen2d.moveTo(p.x * width, p.y * height)));
      pen2d.stroke();
    }
    if (hand) {
      pen2d.beginPath();
      pen2d.arc(hand.x * width, hand.y * height, (hand.fist ? 14 : 10) * unit, 0, 2 * Math.PI);
      pen2d.fillStyle = hand.fist ? '#e5446d' : hand.open ? '#34c759' : '#c8cdd6';   // pink: drawing; green: open, stopped; grey: half open
      pen2d.fill();
      pen2d.lineWidth = 3 * unit;
      pen2d.strokeStyle = '#1c2330';
      pen2d.stroke();
    }
  }
  // The board can be made bigger (a slider, full screen): draw at the size it is shown, so lines stay sharp.
  new ResizeObserver(() => {
    const box = ink.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const [w, h] = [Math.round(box.width * ratio), Math.round(box.height * ratio)];
    if (w > 0 && h > 0 && (ink.width !== w || ink.height !== h)) {
      ink.width = w;
      ink.height = h;
      paint();
    }
  }).observe(ink);

  function clearSoon() {
    clearTimeout(fading);
    fading = setTimeout(() => { if (!pen) { strokes = []; paint(); } }, SHOW_MS);
  }
  function down(x, y) {
    clearTimeout(fading);
    if (!pen) {
      if (done) { strokes = []; done = false; }    // a new drawing
      strokes.push([]);
      pen = true;
      onPen(true);
    }
    strokes[strokes.length - 1].push({ x, y });
    lastPenAt = performance.now();
  }
  function up() {
    if (!pen) return;
    pen = false;
    openSince = performance.now();
    onPen(false);
  }
  function sizeOf(points) {
    if (points.length < 2) return 0;
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  }
  function finish() {
    done = true;
    const points = strokes.flat();
    if (points.length < 4 || sizeOf(points) < MIN_SIZE) { strokes = []; return paint(); }
    const drawn = strokes.map((stroke) => stroke.slice());
    onShape(recognise(drawn), () => snapshot(drawn));
    clearSoon();
  }

  // ---- the camera
  function frame(found) {
    if (found) {
      const raw = { x: found.x, y: found.y };
      smooth = smooth ? { x: smooth.x + SMOOTH * (raw.x - smooth.x), y: smooth.y + SMOOTH * (raw.y - smooth.y) } : raw;
      hand = { ...smooth, fist: found.fist, open: found.open };
    } else {
      hand = null;
      smooth = null;
    }
    const now = performance.now();
    const bandMoving = bandOn && now - bandMovedAt < BAND_MOVING_MS;
    openFrames = found?.open ? openFrames + 1 : 0;
    onHand(found ? (found.fist ? 'closed' : found.open ? 'open' : 'between') : 'none');
    if (found?.fist) {
      noFist = 0;
      if (waitOpen && !bandMoving) return paint();  // still holding the fist after finishing
      waitOpen = false;
      down(smooth.x, smooth.y);
      // The band feels the hand has stopped, fist still closed: that is the end too.
      if (bandOn && now - bandMovedAt > BAND_STILL_MS && sizeOf(strokes.flat()) >= MIN_SIZE) {
        up();
        finish();
        waitOpen = true;
      }
    } else {
      noFist++;
      waitOpen = false;
      // No fist in the picture. If the band still feels the wrist moving, it is a blur: keep the pen down.
      // A clearly open hand lifts the pen at once, whatever the band feels.
      if (pen && (openFrames >= OPEN_FRAMES || (noFist >= LIFT_FRAMES && !bandMoving))) up();
      if (!pen && !done && strokes.length && performance.now() - openSince > DONE_MS) finish();
    }
    paint();
  }
  /** 'closed' (a fist: draw), 'open' (stop) or 'between', from the finger joints and the model's label. */
  function grip(result) {
    const marks = result.worldLandmarks?.[0] ?? result.landmarks[0];      // world: real sizes, whatever way the hand faces
    const wide = result.worldLandmarks?.[0] ? 1 : (video.videoWidth || 4) / (video.videoHeight || 3);
    const far = (a, b) => Math.hypot((marks[a].x - marks[b].x) * wide, marks[a].y - marks[b].y, (marks[a].z ?? 0) - (marks[b].z ?? 0));
    let curled = 0, straight = 0;
    for (const [tip, knuckle] of [[8, 5], [12, 9], [16, 13], [20, 17]]) {   // index, middle, ring, little finger
      const reach = far(tip, 0) / (far(knuckle, 0) || 1);
      if (reach < CURLED) curled++;
      else if (reach > STRAIGHT) straight++;
    }
    const label = result.gestures?.[0]?.[0];
    const says = (name) => label?.categoryName === name && label.score > 0.6;
    if ((curled >= 3 && straight === 0) || (says('Closed_Fist') && straight <= 1)) return 'closed';
    if (straight >= 3 || (says('Open_Palm') && curled <= 1)) return 'open';
    return 'between';
  }
  /** The hand sign in this frame (one of SIGNS), or null. Never while a line is being drawn. */
  function signOf(result) {
    const label = result.gestures?.[0]?.[0];
    if (!label || label.score < 0.6 || !SIGNS.includes(label.categoryName)) return null;
    if (pen && sizeOf(strokes.flat()) >= MIN_SIZE / 2) return null;      // drawing: a fist with the thumb out is still a fist
    return label.categoryName;
  }
  /** Count how long a sign has been held; say it once, and again only after the hand has let go. */
  function held(shown) {
    if (shown && shown === sign) signFrames++;
    else { sign = shown; signFrames = shown ? 1 : 0; }
    if (!shown) { if (++signGone >= SIGN_GONE) signSaid = null; return; }
    signGone = 0;
    if (signFrames === SIGN_FRAMES && shown !== signSaid) {
      signSaid = shown;
      if (pen) { strokes.pop(); up(); }            // the dot the fist left before the thumb came out
      if (!strokes.length || done) { strokes = []; paint(); }
      onSign(shown);
    }
  }
  function loop() {
    if (!running) return;
    if (video.readyState >= 2) {
      const result = recogniser.recognizeForVideo(video, performance.now());
      const marks = result.landmarks?.[0];
      if (marks) {
        // the middle of the palm: the wrist and the four knuckles. The picture is shown
        // mirrored (like a mirror), so x is turned round to match what you see.
        const palm = [0, 5, 9, 13, 17].map((i) => marks[i]);
        const x = 1 - palm.reduce((a, m) => a + m.x, 0) / palm.length;
        const y = palm.reduce((a, m) => a + m.y, 0) / palm.length;
        const shown = signOf(result);
        const state = shown ? 'between' : grip(result);      // a hand sign is neither a fist nor an open hand
        held(shown);
        frame({ x, y, fist: state === 'closed', open: state === 'open' });
      } else { held(null); frame(null); }
    }
    requestAnimationFrame(loop);
  }

  async function start() {
    if (running) return;
    onState('loading');
    try {
      if (!recogniser) {
        const vision = await import(`${VISION}/vision_bundle.mjs`);
        const files = await vision.FilesetResolver.forVisionTasks(`${VISION}/wasm`);
        recogniser = await vision.GestureRecognizer.createFromOptions(files, {
          baseOptions: { modelAssetPath: MODEL }, runningMode: 'VIDEO', numHands: 1,
        });
      }
    } catch {
      return onState('no-model');
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    } catch (e) {
      return onState(e?.name === 'NotAllowedError' ? 'denied' : 'no-camera');
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    running = true;
    onState('on');
    requestAnimationFrame(loop);
  }
  function stop() {
    running = false;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    video.srcObject = null;
    hand = null;
    up();
    paint();
    onState('off');
  }

  // ---- the mouse or a finger on the picture: pressed = the fist
  const at = (event) => {
    const box = ink.getBoundingClientRect();
    return [(event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height];
  };
  ink.addEventListener('pointerdown', (event) => {
    if (running) return;                         // the camera draws now
    event.preventDefault();
    try { ink.setPointerCapture(event.pointerId); } catch { /* keeps working without it */ }
    clearTimeout(mouseTimer);
    down(...at(event));
    paint();
  });
  ink.addEventListener('pointermove', (event) => { if (pen && !running) { down(...at(event)); paint(); } });
  const lift = () => {
    if (!pen || running) return;
    up();
    clearTimeout(mouseTimer);
    mouseTimer = setTimeout(finish, DONE_MS);      // time for a second stroke (the dot of a "?")
  };
  ink.addEventListener('pointerup', lift);
  ink.addEventListener('pointercancel', lift);

  paint();
  return {
    start,
    stop,
    get on() { return running; },
    /** The hand is drawing, or just was: shakes on the band are not meant as shakes now. */
    get busy() { return pen || performance.now() - lastPenAt < BUSY_MS; },
    /** From the band: is the wrist moving now (turning faster than a hand at rest)? */
    motion(moving) {
      bandOn = true;
      if (moving) bandMovedAt = performance.now();
    },
    /** One camera frame: { x, y, fist } from 0 to 1, or null with no hand. The camera loop calls it; so can a test. */
    frame,
    clear() { strokes = []; done = false; paint(); },
  };
}

/** The drawing alone, black on white and centred, as a PNG for the AI to look at. */
function snapshot(strokes) {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const pen = canvas.getContext('2d');
  pen.fillStyle = '#fff';
  pen.fillRect(0, 0, 320, 240);
  const points = strokes.flat();
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
  const size = Math.max(Math.max(...xs) - x0, Math.max(...ys) - y0) || 1;
  const scale = 200 / size;
  const ox = (320 - (Math.max(...xs) - x0) * scale) / 2, oy = (240 - (Math.max(...ys) - y0) * scale) / 2;
  pen.strokeStyle = '#000';
  pen.lineWidth = 6;
  pen.lineCap = pen.lineJoin = 'round';
  for (const stroke of strokes) {
    pen.beginPath();
    stroke.forEach((p, i) => {
      const x = ox + (p.x - x0) * scale, y = oy + (p.y - y0) * scale;
      if (i) pen.lineTo(x, y); else pen.moveTo(x, y);
    });
    pen.stroke();
  }
  return canvas.toDataURL('image/png');
}
