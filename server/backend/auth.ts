const encoder = new TextEncoder();

export const ACCESS_TOKEN_TTL = 60 * 60 * 1_000;
export const REFRESH_TOKEN_TTL = 90 * 24 * 60 * 60 * 1_000;
export const AUTH_CODE_TTL = 5 * 60 * 1_000;
export const ADMIN_SESSION_TTL = 60 * 60 * 1_000;
// Cloudflare Workers rejects PBKDF2 requests above 100,000 iterations.
export const PASSWORD_ITERATIONS = 100_000;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

export function equalStrings(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export async function hashPassword(password: string, salt: string, iterations = PASSWORD_ITERATIONS): Promise<string> {
  const root = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations, hash: "SHA-256" },
    root,
    256,
  );
  return base64UrlEncode(new Uint8Array(bits));
}

export async function verifyPassword(password: string, hash: string, salt: string, iterations: number): Promise<boolean> {
  return equalStrings(hash, await hashPassword(password, salt, iterations));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export function cookie(name: string, value: string, maxAge: number, secure: boolean, sameSite: "Lax" | "Strict" = "Lax"): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge))}; HttpOnly; SameSite=${sameSite}${secure ? "; Secure" : ""}`;
}

export function clearedCookie(name: string, secure: boolean): string {
  return cookie(name, "", 0, secure);
}

export function validEmail(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 12 && value.length <= 256;
}

export function validExtensionRedirect(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "chrome-extension:" || url.protocol === "moz-extension:") && url.pathname === "/auth/callback.html" && !url.search && !url.hash;
  } catch {
    return false;
  }
}
