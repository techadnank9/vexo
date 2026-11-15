// The landing page's three bits of movement: sections rise in once, the tagline lights up
// word by word as it is scrolled past, and the menu opens on a phone.

// Sections: seen once, never replayed.
const seen = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    entry.target.classList.add('seen');
    seen.unobserve(entry.target);
  }
}, { threshold: 0.12 });
for (const section of document.querySelectorAll('.reveal')) seen.observe(section);

// The tagline: split into words; each one turns from faint to full as it crosses a line
// 70 percent of the way down the window. One observer per word, no scroll listener.
const line = document.getElementById('reveal');
const words = line.textContent.trim().split(/\s+/);
line.textContent = '';
const lit = new IntersectionObserver((entries) => {
  for (const entry of entries) entry.target.classList.toggle('on', entry.isIntersecting || entry.boundingClientRect.top < 0);
}, { rootMargin: '0px 0px -30% 0px', threshold: 1 });
words.forEach((word, i) => {
  const span = document.createElement('span');
  span.className = 'word';
  span.textContent = word;
  span.style.transitionDelay = `${Math.min(i * 40, 400)}ms`;
  line.append(span, ' ');
  lit.observe(span);
});

// The menu on a phone.
const nav = document.querySelector('.nav');
const toggle = document.getElementById('toggle');
function menu(open) {
  nav.classList.toggle('open', open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close the menu' : 'Open the menu');
}
toggle.addEventListener('click', () => menu(!nav.classList.contains('open')));
for (const link of document.querySelectorAll('.links a')) link.addEventListener('click', () => menu(false));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') menu(false); });
