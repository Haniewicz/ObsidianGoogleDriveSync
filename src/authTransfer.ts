import QRCode from "qrcode";
import { StoredAuth } from "./types";

const PBKDF2_ITERATIONS = 200_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export type AuthTransferPayload =
  | { v: 1; encrypted: false; auth: StoredAuth }
  | { v: 1; encrypted: true; salt: string; iv: string; data: string };

export function buildTransferUrl(payload: AuthTransferPayload): string {
  const json = JSON.stringify(payload);
  const b64 = btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `obsidian://google-drive-vault-sync?action=import-auth&payload=${b64}`;
}

export function decodeTransferPayload(raw: string): AuthTransferPayload {
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(b64);
  return JSON.parse(json) as AuthTransferPayload;
}

export async function encryptAuth(auth: StoredAuth, password: string): Promise<AuthTransferPayload> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const plaintext = enc.encode(JSON.stringify(auth));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    v: 1,
    encrypted: true,
    salt: bufToHex(salt),
    iv: bufToHex(iv),
    data: bufToBase64(new Uint8Array(ciphertext))
  };
}

export async function decryptAuth(
  payload: Extract<AuthTransferPayload, { encrypted: true }>,
  password: string
): Promise<StoredAuth> {
  const enc = new TextEncoder();
  const salt = hexToBuf(payload.salt);
  const iv = hexToBuf(payload.iv);
  const data = base64ToBuf(payload.data);
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  } catch {
    throw new Error("Wrong password or corrupted QR data.");
  }
  return JSON.parse(new TextDecoder().decode(plaintext)) as StoredAuth;
}

export async function generateQRCodeSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: "svg", margin: 2, width: 300 });
}

function bufToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBuf(hex: string): Uint8Array {
  const result = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    result[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return result;
}

function bufToBase64(buf: Uint8Array): string {
  let binary = "";
  for (const byte of buf) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBuf(b64: string): Uint8Array {
  const binary = atob(b64);
  const result = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i);
  return result;
}
