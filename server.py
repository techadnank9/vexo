# The project's small web server: the pages, plus /speak, which turns a phrase into speech
# with ElevenLabs. The key stays here (read from .env); the page never sees it.
#   python3 server.py            then open http://localhost:3000/gesture-speak/
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if __name__ == "__main__" and len(sys.argv) > 1 else 3000
LOCAL = __name__ == "__main__"      # run as "python3 server.py" on your own computer, not imported by a hosted copy
API = "https://api.elevenlabs.io/v1"
MODELS = ("eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_multilingual_v2")
MAX_TEXT = 200
cache = {}          # phrase -> mp3 bytes: a phrase is paid for once
voice = {}          # the voice in use, found on the first call
# This Python may come without the list of trusted web certificates: use the one macOS has.
TRUST = ssl.create_default_context(cafile="/etc/ssl/cert.pem" if os.path.exists("/etc/ssl/cert.pem") else None)


def env(name):
    try:
        with open(os.path.join(ROOT, ".env")) as f:
            for line in f:
                key, _, value = line.strip().partition("=")
                if key == name:
                    return value.strip()
    except OSError:
        pass
    return os.environ.get(name, "")


def call(path, body=None):
    request = urllib.request.Request(API + path, data=None if body is None else json.dumps(body).encode(),
                                     headers={"xi-api-key": env("ELEVENLABS_API_KEY"), "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=20, context=TRUST) as answer:
        return answer.read()


def speak(text):
    if text in cache:
        return cache[text]
    if "id" not in voice:
        wanted = env("ELEVENLABS_VOICE_ID")
        voice["id"] = wanted or json.loads(call("/voices"))["voices"][0]["voice_id"]
    problem = None
    for model in ([voice["model"]] if "model" in voice else MODELS):
        try:
            sound = call("/text-to-speech/%s?output_format=mp3_44100_128" % voice["id"], {"text": text, "model_id": model})
            voice["model"] = model
            if len(cache) < 500:
                cache[text] = sound
            return sound
        except urllib.error.HTTPError as e:
            problem = "ElevenLabs said %s: %s" % (e.code, e.read()[:300].decode("utf-8", "replace"))
    raise RuntimeError(problem)


SENTENCE_MODEL = "gpt-4.1-mini"
SENTENCE_RULES = (
    "A person who cannot speak makes hand gestures; each gesture stands for a word or short phrase. "
    "You get the phrases in the order they were made. Join them into what the person means to say, as one "
    "short, natural spoken utterance in the first person. Keep every phrase's meaning and their order, add only "
    "the small words and punctuation that natural speech needs, never add new ideas, never explain. "
    "Answer with the utterance only.")
sentences = {}      # the phrases, joined -> the sentence: the same run is paid for once


def sentence(phrases):
    key = " | ".join(phrases)
    if key in sentences:
        return sentences[key]
    body = {"model": SENTENCE_MODEL, "temperature": 0.2, "max_tokens": 80,
            "messages": [{"role": "system", "content": SENTENCE_RULES},
                         {"role": "user", "content": json.dumps(phrases)}]}
    request = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=json.dumps(body).encode(),
                                     headers={"Authorization": "Bearer " + env("OPENAI_API_KEY"), "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=15, context=TRUST) as answer:
        text = json.loads(answer.read())["choices"][0]["message"]["content"].strip().strip('"')[:MAX_TEXT]
    if len(sentences) < 500:
        sentences[key] = text
    return text


GUESS_RULES = (
    "You are the voice of a person who cannot speak. They are talking face to face with someone who can hear. "
    "Instead of speaking they drew a quick sketch in the air with their fist, so the lines are rough, wobbly "
    "and in one colour. Turn the sketch into the one sentence they mean to say to the other person right now, "
    "and it will be spoken out loud for them.\n"
    "How to get it right:\n"
    "1. First decide what the sketch shows. Be literal: a cup is a cup, a house is a house.\n"
    "2. Read the conversation so far. If the other person just asked or said something, the sentence is the "
    "reply to that, built from what was drawn (asked what they want to drink, a cup means they would like a "
    "coffee or tea, please). If there is no conversation yet, make the plainest sentence someone would mean "
    "by showing that thing (a cup: I would like something to drink, please).\n"
    "3. Stay with what was drawn. Never add names, places, times, numbers, feelings or plans that are neither "
    "in the sketch nor in the conversation. Never tell a story.\n"
    "4. Write it as they would say it: first person, natural, polite, 3 to 12 words, one sentence.\n"
    "5. A word, letter or number written out is said as it is, in a sentence if the conversation calls for one.\n"
    "6. If the sketch is not clearly one thing, do not guess: saying nothing is better than saying something "
    "wrong.\n"
    "Situation: {scene}.\n"
    "Answer with JSON only: {{\"drawing\": \"what it shows, 1 to 3 words\", \"say\": \"the sentence\"}}, or "
    "{{\"drawing\": \"unclear\", \"say\": \"\"}}."
)
MAX_IMAGE = 400_000   # characters of the drawing as a data address (a 320 x 240 PNG of a few lines is about 10 000)


def guess(image, scene, history=()):
    """A drawing (PNG as a data address) and the conversation so far -> {"drawing": ..., "say": ...}:
    OpenAI looks at the picture and writes the sentence the person means, as a reply to what was said."""
    said_so_far = "\n".join("%s: %s" % ("They (the person who can hear)" if who == "them" else "Me", text) for who, text in history)
    question = ("The conversation so far, oldest first:\n%s\n\nMy next sentence is this sketch. What do I say?" % said_so_far
                if said_so_far else "There is no conversation yet. This sketch is the first thing I say. What do I say?")
    body = {"model": SENTENCE_MODEL, "temperature": 0.2, "max_tokens": 80, "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": GUESS_RULES.format(scene=scene)},
                         {"role": "user", "content": [
                             {"type": "text", "text": question},
                             {"type": "image_url", "image_url": {"url": image, "detail": "low"}}]}]}
    request = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=json.dumps(body).encode(),
                                     headers={"Authorization": "Bearer " + env("OPENAI_API_KEY"), "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=20, context=TRUST) as answer:
        said = json.loads(json.loads(answer.read())["choices"][0]["message"]["content"])
    return {"drawing": str(said.get("drawing", ""))[:60], "say": str(said.get("say", "")).strip().strip('"')[:160]}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def hidden(self):
        """.env, .git, .venv and every other dot file are never served."""
        return any(part.startswith(".") for part in self.path.split("?")[0].split("/") if part)

    def do_GET(self):
        if self.hidden():
            return self.send_error(404)
        return super().do_GET()

    def do_HEAD(self):
        if self.hidden():
            return self.send_error(404)
        return super().do_HEAD()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def post_allowed(self):
        origin = self.headers.get("Origin", "")
        return origin in ("http://localhost:%d" % PORT, "http://127.0.0.1:%d" % PORT)

    def do_POST(self):
        if self.path not in ("/speak", "/sentence", "/listen-token", "/guess"):
            return self.send_error(404)
        # Only this computer's own pages may ask: a web site open in another tab may not.
        if not self.post_allowed():
            return self.send_error(403)
        if self.path == "/listen-token":
            return self.do_listen_token()
        if self.path == "/guess":
            return self.do_guess()
        try:
            length = int(self.headers.get("Content-Length", "0"))
            asked = json.loads(self.rfile.read(min(length, 4096)))
            if self.path == "/sentence":
                return self.do_sentence(asked)
            text = str(asked["text"]).strip()
        except (ValueError, KeyError, TypeError):
            return self.send_error(400)
        if not text or len(text) > MAX_TEXT:
            return self.send_error(400)
        if not env("ELEVENLABS_API_KEY"):
            return self.send_error(503, "No ELEVENLABS_API_KEY in .env")
        try:
            sound = speak(text)
        except Exception as e:                      # the page falls back to the browser's own voice
            print("speak failed:", e, file=sys.stderr)
            return self.send_error(502, "ElevenLabs did not answer")
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(sound)))
        self.end_headers()
        self.wfile.write(sound)

    def do_guess(self):
        """{"image": "data:image/png;base64,...", "scene": "Ordering a coffee", "history": [{"who": "them", "text": ...}]}
        -> {"drawing": ..., "say": ...}"""
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > MAX_IMAGE + 1000:
                return self.send_error(413)
            asked = json.loads(self.rfile.read(length))
            image, scene = str(asked["image"]), str(asked.get("scene", "an everyday conversation"))[:80]
            # the last few lines of the conversation, so the sentence answers what was just said
            history = [("them" if one.get("who") == "them" else "me", str(one.get("text", "")).strip()[:200])
                       for one in (asked.get("history") or [])[-8:] if isinstance(one, dict) and str(one.get("text", "")).strip()]
        except (ValueError, KeyError, TypeError, AttributeError):
            return self.send_error(400)
        if not image.startswith("data:image/png;base64,") or len(image) > MAX_IMAGE:
            return self.send_error(400)
        if not env("OPENAI_API_KEY"):
            return self.send_error(503, "No OPENAI_API_KEY in .env")
        try:
            answer = json.dumps(guess(image, scene, history)).encode()
        except Exception as e:                      # the page says it could not guess
            print("guess failed:", e, file=sys.stderr)
            return self.send_error(502, "OpenAI did not answer")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(answer)))
        self.end_headers()
        self.wfile.write(answer)

    def do_listen_token(self):
        """Live captions: a Deepgram key that works for 30 seconds, long enough to open the
        connection. The page uses it to send the band's microphone to Deepgram; the real key
        stays here."""
        key = env("DEEPGRAM_API_KEY")
        if not key:
            return self.send_error(503, "No DEEPGRAM_API_KEY in .env")
        try:
            request = urllib.request.Request("https://api.deepgram.com/v1/auth/grant", data=b"{}", method="POST",
                                             headers={"Authorization": "Token " + key, "Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=10, context=TRUST) as answer:
                token = json.loads(answer.read())["access_token"]
            scheme = "bearer"
        except urllib.error.HTTPError as e:
            if e.code != 403 or not LOCAL:
                print("listen-token failed:", e, file=sys.stderr)
                return self.send_error(502, "Deepgram did not give a token")
            # This key may transcribe but may not hand out short-lived tokens (its role is too
            # low). Then the page on this computer uses the key itself, as the kit's own
            # dashboard does. Only on your own computer (LOCAL): a hosted copy never gives its
            # key to a visitor, and the page there falls back to the browser's speech recognition.
            print("listen-token: this key cannot make short-lived tokens; the page uses the key itself", file=sys.stderr)
            token, scheme = key, "token"
        except Exception as e:
            print("listen-token failed:", e, file=sys.stderr)
            return self.send_error(502, "Deepgram did not give a token")
        answer = json.dumps({"token": token, "scheme": scheme}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(answer)))
        self.end_headers()
        self.wfile.write(answer)

    def do_sentence(self, asked):
        """{"phrases": ["Hello", "How are you?"]} -> {"text": "Hello, how are you?"}"""
        phrases = asked["phrases"]
        if not isinstance(phrases, list) or not 1 <= len(phrases) <= 12:
            return self.send_error(400)
        phrases = [str(one).strip()[:60] for one in phrases]
        if not all(phrases):
            return self.send_error(400)
        if not env("OPENAI_API_KEY"):
            return self.send_error(503, "No OPENAI_API_KEY in .env")
        try:
            answer = json.dumps({"text": sentence(phrases)}).encode()
        except Exception as e:                      # the page then says the phrases as they are
            print("sentence failed:", e, file=sys.stderr)
            return self.send_error(502, "OpenAI did not answer")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(answer)))
        self.end_headers()
        self.wfile.write(answer)


if __name__ == "__main__":
    print("http://localhost:%d/gesture-speak/" % PORT)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
