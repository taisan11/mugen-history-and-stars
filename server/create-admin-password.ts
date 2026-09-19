const password = Bun.argv[2] ?? prompt("Admin password (12+ chars): ");
if (!password || password.length < 12) throw new Error("Password must be at least 12 characters");

const bytes = new Uint8Array(24);
crypto.getRandomValues(bytes);
const salt = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${password}${salt}`));
const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const envPath = new URL("./.env", import.meta.url);
let existing = "";
try { existing = await Bun.file(envPath).text(); } catch { /* Create the file on first use. */ }
const lines = existing.split(/\r?\n/).filter((line) => !line.startsWith("ADMIN_PASSWORD_SALT=") && !line.startsWith("ADMIN_PASSWORD_SHA256=") && line.length > 0);
lines.push(`ADMIN_PASSWORD_SALT=${salt}`, `ADMIN_PASSWORD_SHA256=${hash}`);
await Bun.write(envPath, `${lines.join("\n")}\n`);
console.log(`Wrote ${envPath.pathname}`);
