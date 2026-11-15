const hosted = location.hostname === 'vexo-sage.vercel.app';
const code = document.getElementById('cloud-access-code');

if (hosted) document.getElementById('cloud-access').hidden = false;

// Locally the Python server already restricts requests to the loopback origin.
export function cloudFetch(path, options) {
    if (!hosted) return fetch(path, options);

    const headers = new Headers(options.headers);
    if (code.value) headers.set('X-Vexo-Access-Code', code.value);
    return fetch(path, { ...options, headers });
}
