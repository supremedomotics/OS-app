import { createHash, randomBytes } from "node:crypto";
import type { OnvifDeviceInfo, OnvifMediaProfile } from "./rtsp-types.js";

/**
 * ONVIF device/media SOAP client (§ STEP 7 — "Never make the installer hand-construct vendor RTSP
 * URLs when ONVIF can supply them"). Real WS-Security UsernameToken (digest) authentication per
 * the ONVIF Core Specification §5.12.2.1 (`PasswordDigest = Base64(SHA1(Nonce + Created +
 * Password))`), real GetDeviceInformation/GetProfiles/GetStreamUri SOAP bodies. XML is read with
 * the same tolerant regex approach as `onvif-wsdiscovery.ts` (no XML dependency added).
 */
function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1]!.trim() : null;
}
function extractAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*\\b${attr}="([^"]*)"`, "i");
  const m = xml.match(re);
  return m ? m[1]! : null;
}
function extractBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[0]!);
  return out;
}

export interface OnvifCredentials {
  username: string;
  password: string;
}

/** Builds a WS-Security UsernameToken header block (digest, not plaintext — ONVIF Core Spec
 * §5.12.2.1). A fresh nonce/timestamp every call, so this is never reused across requests. */
export function buildWsSecurityHeader(creds: OnvifCredentials, now = new Date(), nonceBytes = randomBytes(16)): string {
  const created = now.toISOString().replace(/\.\d+Z$/, ".000Z");
  const digest = createHash("sha1").update(Buffer.concat([nonceBytes, Buffer.from(created, "utf8"), Buffer.from(creds.password, "utf8")])).digest("base64");
  const nonceB64 = nonceBytes.toString("base64");
  return (
    `<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" ` +
    `xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">` +
    `<wsse:UsernameToken>` +
    `<wsse:Username>${escapeXml(creds.username)}</wsse:Username>` +
    `<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>` +
    `<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonceB64}</wsse:Nonce>` +
    `<wsu:Created>${created}</wsu:Created>` +
    `</wsse:UsernameToken>` +
    `</wsse:Security>`
  );
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function envelope(body: string, security?: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">` +
    `<s:Header>${security ?? ""}</s:Header>` +
    `<s:Body>${body}</s:Body>` +
    `</s:Envelope>`
  );
}

export type SoapFetch = (url: string, body: string) => Promise<{ status: number; text: string }>;

/** Real HTTP POST (SOAP action via body content only — ONVIF services accept a generic
 * `text/xml` POST). Injectable for tests. Bounded timeout so one unresponsive camera never
 * hangs commissioning indefinitely (§ STEP 12). */
export const realSoapFetch: SoapFetch = async (url, body) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/soap+xml; charset=utf-8" },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
};

export class OnvifSoapError extends Error {}

async function call(fetchImpl: SoapFetch, endpoint: string, body: string, security?: string): Promise<string> {
  const res = await fetchImpl(endpoint, envelope(body, security));
  if (res.status === 401) throw new OnvifSoapError("authentication failed");
  if (res.status >= 400) {
    const fault = extractTag(res.text, "Reason") ?? extractTag(res.text, "faultstring");
    throw new OnvifSoapError(fault ? `ONVIF request failed: ${fault}` : `ONVIF request failed (HTTP ${res.status})`);
  }
  return res.text;
}

/** GetDeviceInformation (unauthenticated on many cameras, but WS-Security is sent whenever
 * credentials are supplied — some vendors require it even here). */
export async function getDeviceInformation(
  endpoint: string,
  creds: OnvifCredentials | null,
  fetchImpl: SoapFetch = realSoapFetch,
): Promise<OnvifDeviceInfo> {
  const body = `<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>`;
  const security = creds ? buildWsSecurityHeader(creds) : undefined;
  const xml = await call(fetchImpl, endpoint, body, security);
  return {
    manufacturer: extractTag(xml, "Manufacturer"),
    model: extractTag(xml, "Model"),
    firmwareVersion: extractTag(xml, "FirmwareVersion"),
    serialNumber: extractTag(xml, "SerialNumber"),
    hardwareId: extractTag(xml, "HardwareId"),
  };
}

/** GetProfiles against the Media service — REQUIRES credentials on virtually every real camera.
 * Returns [] (never throws) when the response has no usable `<Profiles>` at all — a partial ONVIF
 * implementation with zero media profiles is a real, if unhelpful, camera state (§ STEP 12 —
 * "ONVIF-without-usable-media-profile"), not a driver bug. */
export async function getMediaProfiles(
  mediaEndpoint: string,
  creds: OnvifCredentials,
  fetchImpl: SoapFetch = realSoapFetch,
): Promise<OnvifMediaProfile[]> {
  const body = `<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>`;
  const xml = await call(fetchImpl, mediaEndpoint, body, buildWsSecurityHeader(creds));
  const blocks = extractBlocks(xml, "Profiles");
  return blocks.map((block, i) => {
    const token = extractAttr(block, "Profiles", "token") ?? `profile-${i}`;
    const name = extractTag(block, "Name");
    const isLikelyMain = i === 0 || /main|stream1|high/i.test(`${name ?? ""} ${token}`);
    return { token, name, isLikelyMain };
  });
}

/** GetStreamUri for one profile token — returns the real RTSP URI ONVIF reports, credential-free
 * (ONVIF's own StreamUri never embeds a password; the driver adds `rtsp://user:pass@...` itself
 * only at the moment it opens a real connection — see rtsp-camera-service.ts). */
export async function getStreamUri(
  mediaEndpoint: string,
  profileToken: string,
  creds: OnvifCredentials,
  fetchImpl: SoapFetch = realSoapFetch,
): Promise<string | null> {
  const body =
    `<GetStreamUri xmlns="http://www.onvif.org/ver10/media/wsdl">` +
    `<StreamSetup><Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream>` +
    `<Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport></StreamSetup>` +
    `<ProfileToken>${escapeXml(profileToken)}</ProfileToken>` +
    `</GetStreamUri>`;
  const xml = await call(fetchImpl, mediaEndpoint, body, buildWsSecurityHeader(creds));
  return extractTag(xml, "Uri");
}

/** The Media service endpoint, resolved from GetCapabilities (falls back to swapping
 * `device_service` for `media_service` on the device endpoint — the near-universal convention —
 * when GetCapabilities itself doesn't answer usefully, e.g. a partial ONVIF stack). */
export async function getMediaServiceEndpoint(
  deviceEndpoint: string,
  creds: OnvifCredentials,
  fetchImpl: SoapFetch = realSoapFetch,
): Promise<string> {
  try {
    const body = `<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>Media</Category></GetCapabilities>`;
    const xml = await call(fetchImpl, deviceEndpoint, body, buildWsSecurityHeader(creds));
    const media = extractTag(xml, "Media");
    const xaddr = media ? extractTag(media, "XAddr") : extractTag(xml, "XAddr");
    if (xaddr) return xaddr;
  } catch {
    // fall through to the naming-convention fallback (§ STEP 12 — partial ONVIF implementation)
  }
  return deviceEndpoint.replace(/device_service/i, "media_service");
}
