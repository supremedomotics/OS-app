import forge from "node-forge";

/**
 * @supreme/hub-pki — real X.509 PKI for mutual-TLS between a hub and the cloud Tunnel Broker
 * (ADR 0008/0009). The Hub CA signs a short-lived device certificate per hub; the broker runs a
 * TLS server with `requestCert` and verifies the presented client cert chains to the CA, then
 * reads the hub id from the cert's CN. This is genuine transport-layer mutual auth — not an
 * application-layer challenge.
 *
 * Certs are RSA-2048 (universally supported by Node's TLS stack). The hub's Ed25519 identity from
 * @supreme/hub-identity remains for offline signing; this is the separate credential used to
 * authenticate the live connection.
 */

export interface CertKeyPem {
  /** PEM-encoded X.509 certificate. */
  certPem: string;
  /** PEM-encoded PKCS#8 private key. */
  keyPem: string;
}

export interface CertAuthority {
  /** The CA certificate (PEM) — trust anchor the broker verifies device certs against. */
  caCertPem: string;
  /** The CA private key (PEM) — sealed in the cloud (HSM/KMS in production). */
  caKeyPem: string;
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function keyToPkcs8Pem(key: forge.pki.rsa.PrivateKey): string {
  return forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(key)));
}

/** Create a self-signed Hub Certificate Authority (root of trust for device certs). */
export function generateHubCa(opts: { commonName?: string; notBeforeMs?: number; validMs?: number } = {}): CertAuthority {
  const now = opts.notBeforeMs ?? Date.now();
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(now);
  cert.validity.notAfter = new Date(now + (opts.validMs ?? 10 * YEAR_MS));
  const attrs = [{ name: "commonName", value: opts.commonName ?? "Supreme Hub CA" }, { name: "organizationName", value: "Supreme Domotics" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { caCertPem: forge.pki.certificateToPem(cert), caKeyPem: keyToPkcs8Pem(keys.privateKey) };
}

/**
 * Issue a short-lived device certificate for a hub, signed by the Hub CA. The hub id is the
 * certificate CN (and a SAN), so the broker can identify the hub from its verified cert.
 */
export function issueDeviceCert(
  ca: CertAuthority,
  input: { hubUuid: string; notBeforeMs?: number; ttlMs?: number; serial?: string },
): CertKeyPem {
  const now = input.notBeforeMs ?? Date.now();
  const caCert = forge.pki.certificateFromPem(ca.caCertPem);
  const caKey = forge.pki.privateKeyFromPem(ca.caKeyPem);

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = input.serial ?? forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date(now);
  cert.validity.notAfter = new Date(now + (input.ttlMs ?? 30 * 24 * 60 * 60 * 1000)); // 30d, auto-renewed
  cert.setSubject([{ name: "commonName", value: input.hubUuid }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", clientAuth: true, serverAuth: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: input.hubUuid }] }, // DNS SAN = hubUuid
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: keyToPkcs8Pem(keys.privateKey) };
}

/** Issue a TLS server certificate (for the broker) signed by the CA. */
export function issueServerCert(ca: CertAuthority, input: { commonName: string; notBeforeMs?: number; ttlMs?: number }): CertKeyPem {
  const now = input.notBeforeMs ?? Date.now();
  const caCert = forge.pki.certificateFromPem(ca.caCertPem);
  const caKey = forge.pki.privateKeyFromPem(ca.caKeyPem);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date(now);
  cert.validity.notAfter = new Date(now + (input.ttlMs ?? YEAR_MS));
  cert.setSubject([{ name: "commonName", value: input.commonName }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: input.commonName }, { type: 7, ip: "127.0.0.1" }] },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: keyToPkcs8Pem(keys.privateKey) };
}

/** Verify a certificate (PEM) chains to the given CA and is currently valid. */
export function verifyAgainstCa(certPem: string, caCertPem: string, nowMs: number = Date.now()): { valid: boolean; reason?: string } {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    const caCert = forge.pki.certificateFromPem(caCertPem);
    const now = new Date(nowMs);
    if (now < cert.validity.notBefore) return { valid: false, reason: "not yet valid" };
    if (now >= cert.validity.notAfter) return { valid: false, reason: "expired" };
    if (!caCert.verify(cert)) return { valid: false, reason: "not signed by CA" };
    return { valid: true };
  } catch (err) {
    return { valid: false, reason: (err as Error).message };
  }
}

/** Extract the hub id (certificate CN) from a device certificate PEM. */
export function hubIdFromCert(certPem: string): string | null {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    const cn = cert.subject.getField("CN");
    return cn?.value ?? null;
  } catch {
    return null;
  }
}
