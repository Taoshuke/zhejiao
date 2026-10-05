/**
 * 以 GitHub App 身份调用 GitHub 接口：worker.js 启动同步任务，data-api.js 读仓库里的数据文件、查同步进度。
 *
 * 用应用私钥签一个 10 分钟内有效的应用凭证（JWT），换取安装令牌（1 小时有效），
 * 安装令牌只能访问应用装上的仓库（GITHUB_REPO），权限是 Actions 读写（启动同步、查进度）、Contents 只读（读数据文件）。
 * 私钥不会过期，不再有个人令牌到期要重存的问题；应用的接口额度也和个人账号分开计算，
 * 本机用 gh 发再多请求也不会连带挡住同步。
 *
 * 需要的配置：GITHUB_APP_ID、GITHUB_APP_INSTALLATION_ID（wrangler.jsonc 的 vars，不是密钥）；
 * 密钥 GITHUB_APP_PRIVATE_KEY（应用页面生成的 .pem 文件全文）。
 */
const API = "https://api.github.com";
// 安装令牌剩余不到这么久就换新的，免得用到一半过期
const REFRESH_MARGIN_MS = 5 * 60_000;

const encoder = new TextEncoder();

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function derLength(n) {
  if (n < 0x80) return [n];
  const out = [];
  for (; n > 0; n >>= 8) out.unshift(n & 0xff);
  return [0x80 | out.length, ...out];
}

// GitHub 下发的私钥是 PKCS#1（BEGIN RSA PRIVATE KEY），WebCrypto 只认 PKCS#8，
// 在外面套一层 PKCS#8 结构：SEQUENCE { 版本 0, 算法 rsaEncryption, OCTET STRING { PKCS#1 } }
export function pemToPkcs8(pem) {
  const pkcs1 = /-----BEGIN RSA PRIVATE KEY-----/.test(pem);
  if (!pkcs1 && !/-----BEGIN PRIVATE KEY-----/.test(pem)) throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  if (!pkcs1) return der;
  const version = [0x02, 0x01, 0x00];
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLength(der.length)];
  const inner = version.length + algorithm.length + octet.length + der.length;
  const head = [0x30, ...derLength(inner), ...version, ...algorithm, ...octet];
  const out = new Uint8Array(head.length + der.length);
  out.set(head);
  out.set(der, head.length);
  return out;
}

export async function appJwt(appId, pem, now = Date.now()) {
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const iat = Math.floor(now / 1000) - 60; // 往前拨一分钟，容忍两边时钟误差
  const head = b64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = b64url(encoder.encode(JSON.stringify({ iat, exp: iat + 540, iss: String(appId) })));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url(new Uint8Array(sig))}`;
}

export const githubHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "zhejiao",
});

// 返回可用的安装令牌。storage 是 Durable Object 的存储，缓存的令牌还够用时直接复用
export async function installationToken(env, storage, now = Date.now()) {
  const cached = await storage.get("ghToken");
  if (cached && cached.expiresAt - now > REFRESH_MARGIN_MS) return cached.token;
  const appId = env.GITHUB_APP_ID?.trim();
  const installationId = env.GITHUB_APP_INSTALLATION_ID?.trim();
  const pem = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !installationId || !pem) throw new Error("GitHub App is not configured");
  const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: githubHeaders(await appJwt(appId, pem, now)),
  });
  if (!res.ok) throw new Error(`installation token ${res.status}: ${await res.text()}`);
  const { token, expires_at: expiresAt } = await res.json();
  await storage.put("ghToken", { token, expiresAt: Date.parse(expiresAt) });
  return token;
}

// 令牌被拒（比如应用被卸载后重装）时清掉缓存，下次重新换
export const forgetToken = (storage) => storage.delete("ghToken");
