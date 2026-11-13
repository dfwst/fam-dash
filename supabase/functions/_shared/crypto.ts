// AES-256-GCM for Google refresh tokens at rest.
// Key: Edge Function secret TOKEN_ENC_KEY = 32 random bytes, base64.
// Format: 'v1:<iv b64>:<ciphertext b64>' — the 'v1' lets us rotate keys later
// (add TOKEN_ENC_KEY_V2, encrypt new tokens as v2, still decrypt v1).

const b64 = {
  enc: (u: Uint8Array) => btoa(String.fromCharCode(...u)),
  dec: (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
};

let keyPromise: Promise<CryptoKey> | null = null;
function key(): Promise<CryptoKey> {
  if (!keyPromise) {
    const raw = b64.dec(Deno.env.get('TOKEN_ENC_KEY') ?? '');
    if (raw.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes, base64-encoded');
    keyPromise = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  return keyPromise;
}

export async function encrypt(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // fresh IV every time — never reuse with GCM
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(plain)));
  return `v1:${b64.enc(iv)}:${b64.enc(ct)}`;
}

export async function decrypt(stored: string): Promise<string> {
  const [ver, iv, ct] = stored.split(':');
  if (ver !== 'v1' || !iv || !ct) throw new Error('unknown token format');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(iv) }, await key(), b64.dec(ct));
  return new TextDecoder().decode(pt);
}
