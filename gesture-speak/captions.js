// Live captions: what the other person says, written on the screen for a deaf user.
//
// The band's microphone sends Opus packets (16000 samples a second, 20 ms each). They go to
// Deepgram as they are, nothing decoded, and text comes back while the person speaks.
// The Deepgram key stays in server.py: the page asks /listen-token for a key that works for
// 30 seconds, just long enough to open the connection, and never sees the real one.
//
// While captions are on, everything the band's microphone hears, from everyone near the
// band, goes over the internet to Deepgram. The page says so the whole time.
// Same settings as the kit's dashboard (vexo-open-kit/dashboard/speech/deepgram.js).
import { cloudFetch } from './cloud.js';

const ADDRESS = 'wss://api.deepgram.com/v1/listen?model=nova-3&language=en&encoding=opus&sample_rate=16000'
  + '&channels=1&interim_results=true&smart_format=true&endpointing=100&mip_opt_out=true';
const KEEP_ALIVE_MS = 4000;      // Deepgram closes after 10 s without sound; it asks for a KeepAlive every 3 to 5 s
const LONG_LINE = 300;           // letters: a sentence that never pauses is cut here

const join = (parts) => parts.map((part) => part.trim()).filter(Boolean).join(' ');

/**
 * @param {object} on
 * @param {(text: string, final: boolean) => void} on.text  a first guess (final false) or a finished sentence
 * @param {(state: 'connecting'|'on'|'off'|'no-key'|'failed') => void} on.state
 */
export function captions(on) {
  let socket = null;
  let wanted = false;            // start() was called and stop() not since
  let keepAlive = 0;
  let lastSent = 0;
  let done = [];                 // finished pieces of the sentence being spoken
  let sent = 0;                  // sound packets sent on this connection
  let answered = false;          // Deepgram has sent anything back on this connection
  let openedAt = 0;

  function finish() {
    const sentence = join(done);
    done = [];
    if (sentence) on.text(sentence, true);
  }

  function received(data) {
    answered = true;
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message?.type !== 'Results') return;
    const piece = message.channel?.alternatives?.[0]?.transcript ?? '';
    if (!message.is_final) {
      const live = join([...done, piece]);
      if (live) on.text(live, false);
      return;
    }
    if (piece) done.push(piece);
    // speech_final: Deepgram heard a pause, the sentence is complete.
    if (message.speech_final || join(done).length > LONG_LINE) finish();
    else if (done.length) on.text(join(done), false);
  }

  function close(state) {
    clearInterval(keepAlive);
    const old = socket;
    socket = null;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try { old.close(); } catch { /* closed already */ }
    }
    finish();
    on.state(state);
  }

  return {
    get on() { return Boolean(socket) && socket.readyState === 1; },

    async start() {
      if (wanted) return;
      wanted = true;
      done = [];
      on.state('connecting');
      let token, scheme;
      try {
        const answer = await cloudFetch('/listen-token', { method: 'POST' });
        if (answer.status === 503) { wanted = false; return on.state('no-key'); }
        if (!answer.ok) throw new Error();
        ({ token, scheme = 'bearer' } = await answer.json());   // 'bearer': a 30-second token; 'token': the key itself
      } catch {
        wanted = false;
        return on.state('no-token');                  // no server (a static copy of the page), or Deepgram said no
      }
      if (!wanted) return on.state('off');            // switched off while the token was on its way
      try {
        // A browser cannot add a header to a WebSocket, so Deepgram reads the key from the
        // "protocol" field instead. It is never part of the address.
        socket = new WebSocket(ADDRESS, [scheme, token]);
      } catch {
        wanted = false;
        return on.state('failed');
      }
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        lastSent = openedAt = Date.now();
        sent = 0;
        answered = false;
        keepAlive = setInterval(() => {
          // Sound has gone out for seconds and not one word, not even "nothing heard", came back:
          // this connection is deaf. Say so, and the page listens another way instead.
          if (!answered && sent > 200 && Date.now() - openedAt > 6000) { wanted = false; return close('failed'); }
          if (socket?.readyState === 1 && Date.now() - lastSent >= KEEP_ALIVE_MS) socket.send(JSON.stringify({ type: 'KeepAlive' }));
        }, 1000);
        on.state('on');
      };
      socket.onmessage = (event) => { if (typeof event.data === 'string') received(event.data); };
      socket.onclose = () => { wanted = false; close('failed'); };
    },

    /** One Opus packet from the band's microphone. */
    send(packet) {
      if (socket?.readyState !== 1) return;
      try {
        socket.send(packet);
        sent++;
        lastSent = Date.now();
      } catch { /* closing: onclose reports it */ }
    },

    stop() {
      wanted = false;
      if (socket?.readyState === 1) {
        try { socket.send(JSON.stringify({ type: 'CloseStream' })); } catch { /* closing anyway */ }
      }
      close('off');
    },
  };
}

/**
 * Captions with no key at all: the browser's own speech recognition (Chrome, Edge), on this
 * computer's microphone, not the band's. Chrome sends that sound to Google to turn it into text.
 * Used when there is no Deepgram key, so captions still work at once.
 *
 * @param {object} on   the same as captions(), with states 'on' | 'off' | 'unsupported' | 'denied' | 'failed'
 * @param {() => boolean} muted  true while this page is speaking: what is heard then is our own voice
 */
export function browserCaptions(on, muted = () => false) {
  let Recognition = null;
  let ears = null;
  let wanted = false;

  function begin() {
    ears = new Recognition();
    ears.lang = 'en-US';
    ears.continuous = true;
    ears.interimResults = true;
    ears.onstart = () => on.state('on');
    ears.onresult = (event) => {
      if (muted()) return;
      let guess = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript.trim();
        if (!text) continue;
        if (event.results[i].isFinal) on.text(text.charAt(0).toUpperCase() + text.slice(1), true);
        else guess += `${text} `;
      }
      if (guess.trim()) on.text(guess.trim(), false);
    };
    ears.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;      // a quiet room: it simply starts again
      wanted = false;
      on.state(event.error === 'not-allowed' || event.error === 'service-not-allowed' ? 'denied' : 'failed');
    };
    // Chrome stops listening by itself after a while: start again for as long as captions are on.
    ears.onend = () => { if (wanted) { try { ears.start(); } catch { /* starting already */ } } };
    ears.start();
  }

  return {
    get on() { return wanted; },
    start() {
      if (wanted) return;
      Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
      if (!Recognition) return on.state('unsupported');
      wanted = true;
      try { begin(); } catch { wanted = false; on.state('failed'); }
    },
    send() { /* the band's sound is not used here */ },
    stop() {
      if (!wanted && !ears) return;
      wanted = false;
      try { ears?.stop(); } catch { /* stopped already */ }
      ears = null;
      on.state('off');
    },
  };
}
