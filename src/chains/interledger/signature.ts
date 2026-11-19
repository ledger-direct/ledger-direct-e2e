import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';

/**
 * HTTP message signatures as Open Payments asks for them (RFC 9421, Ed25519).
 *
 * A request covers its method and target URI, the Authorization header when it
 * carries a token, and the digest, length and type of its body when it has one.
 * The signature is a byte sequence of RFC 8941, base64 between colons: a Dassie
 * node reads requests strictly and refuses anything else.
 */
export interface RequestToSign {
  method: string;
  url: string;
  /** The JSON body exactly as it is sent; absent for a request without one. */
  body?: string;
  /** The Authorization header's value (`GNAP <token>`), when the request carries a token. */
  authorization?: string;
}

/** The key as an agent holds it: base64 of the PKCS#8 PEM, the form a test wallet hands out. A bare PEM is taken too. */
export function privateKeyOf(encoded: string): KeyObject {
  const trimmed = encoded.trim();
  const pem = trimmed.startsWith('-----BEGIN') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8');
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    // Never the parser's own message: it may quote what it could not read.
    throw new Error('the Interledger client key is not a PEM private key, or the base64 of one');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`the Interledger client key must be Ed25519, this one is ${key.asymmetricKeyType ?? 'unknown'}`);
  return key;
}

export function contentDigest(body: string): string {
  return `sha-512=:${createHash('sha512').update(body, 'utf8').digest('base64')}:`;
}

/** The covered components, in the order they are signed. */
export function coveredComponents(request: RequestToSign): string[] {
  const components = ['@method', '@target-uri'];
  if (request.authorization !== undefined) components.push('authorization');
  if (request.body !== undefined) components.push('content-digest', 'content-length', 'content-type');
  return components;
}

export function signatureParams(request: RequestToSign, keyId: string, created: number): string {
  // keyid is a quoted string: a quote or a backslash in it would change the header.
  if (keyId === '' || /[^\x20-\x7e]|["\\]/.test(keyId)) throw new Error('the Interledger key id must be printable ASCII without quotes or backslashes');
  const names = coveredComponents(request).map((c) => `"${c}"`).join(' ');
  return `(${names});keyid="${keyId}";created=${created}`;
}

/** The signature base of RFC 9421, section 2.5: one line per component, then the parameters. */
export function signatureBase(request: RequestToSign, params: string): string {
  const lines = coveredComponents(request).map((component) => {
    switch (component) {
      case '@method':
        return `"@method": ${request.method.toUpperCase()}`;
      case '@target-uri':
        return `"@target-uri": ${request.url}`;
      case 'authorization':
        return `"authorization": ${request.authorization ?? ''}`;
      case 'content-digest':
        return `"content-digest": ${contentDigest(request.body ?? '')}`;
      case 'content-length':
        return `"content-length": ${Buffer.byteLength(request.body ?? '', 'utf8')}`;
      default:
        return '"content-type": application/json';
    }
  });
  return [...lines, `"@signature-params": ${params}`].join('\n');
}

/** Every header a signed request has to set itself, the body's and the token's included. */
export function signedHeaders(request: RequestToSign, keyId: string, key: KeyObject, created = Math.floor(Date.now() / 1000)): Record<string, string> {
  const params = signatureParams(request, keyId, created);
  const signature = sign(null, Buffer.from(signatureBase(request, params), 'utf8'), key).toString('base64');
  const headers: Record<string, string> = { Accept: 'application/json', 'Signature-Input': `sig1=${params}`, Signature: `sig1=:${signature}:` };
  if (request.authorization !== undefined) headers.Authorization = request.authorization;
  if (request.body !== undefined) {
    // Content-Length is signed but not set here: fetch writes it from the body, the same
    // number, and refuses a request that names it a second time.
    headers['Content-Type'] = 'application/json';
    headers['Content-Digest'] = contentDigest(request.body);
  }
  return headers;
}
