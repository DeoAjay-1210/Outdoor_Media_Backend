/**
 * Gmail (read-only) service — official Gmail REST API through google-auth-library.
 *
 * Scope is gmail.readonly ONLY (no send / modify / delete). The OAuth client comes from the environment
 * (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI); the connected account's refresh token is stored
 * encrypted in MongoDB (key GMAIL_TOKEN_KEY, else JWT_SECRET). Nothing here logs or returns a secret.
 */
const { OAuth2Client } = require("google-auth-library");

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

const missingConfig = () =>
  ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"].filter((k) => !process.env[k]);

const createClient = () => {
  const missing = missingConfig();
  if (missing.length) {
    const err = new Error(`Missing environment variable(s): ${missing.join(", ")}`);
    err.status = 500;
    throw err;
  }
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
};

/** Consent URL. access_type=offline + prompt=consent so Google returns a refresh token. */
const buildAuthUrl = (state) =>
  createClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    include_granted_scopes: false,
    state,
  });

/** Authorization code -> tokens (refresh_token may be absent if the app was already granted). */
const exchangeCode = async (code) => {
  const { tokens } = await createClient().getToken(code);
  return tokens;
};

// ── the Gmail account connected through the login (OAuth): its refresh token lives ENCRYPTED in MongoDB (collection gmail_connection) ──
// Nothing is written to .env and GOOGLE_REFRESH_TOKEN is not read. Every server that uses the same database uses the same connected account.
const crypto = require("crypto");
const encKey = () => crypto.createHash("sha256").update(String(process.env.GMAIL_TOKEN_KEY || process.env.JWT_SECRET || "")).digest(); // 32 bytes
const encrypt = (plain) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
};
const decrypt = (blob) => {
  const [iv, tag, enc] = String(blob || "").split(".");
  if (!iv || !tag || !enc) return "";
  const d = crypto.createDecipheriv("aes-256-gcm", encKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf8");
};
const connectionModel = () => require("../models/Admin/GmailConnectionSchema");
const CACHE_MS = 5 * 60 * 1000;
let tokenCache = null; // { token, at }

/** Refresh token to use: ONLY the connected account's token stored in the database (the environment is no longer read). */
const loadRefreshToken = async () => {
  if (tokenCache && Date.now() - tokenCache.at < CACHE_MS) return tokenCache.token;
  let token = "";
  try {
    const doc = await connectionModel().findOne({ key: "primary" }).lean();
    if (doc && doc.refreshTokenEnc) token = decrypt(doc.refreshTokenEnc);
  } catch (_) { token = ""; } // database unreachable / wrong key: not connected
  if (token) tokenCache = { token, at: Date.now() }; // an empty result is never cached: a connection made on another server is seen at once
  return token;
};

const authorizedClient = async () => {
  const token = await loadRefreshToken();
  if (!token) {
    const err = new Error("Gmail is not connected yet. Open /api/gmail/oauth/url and sign in with the Gmail account (Connect Gmail).");
    err.status = 409;
    throw err;
  }
  const client = createClient();
  client.setCredentials({ refresh_token: token });
  return client;
};

/** Login finished: check the token, read the account's address, store the token encrypted in MongoDB. */
const connectWithRefreshToken = async (refreshToken, connectedBy = "") => {
  const client = createClient();
  client.setCredentials({ refresh_token: refreshToken });
  const profile = await gmailGet(client, "/profile");
  await connectionModel().findOneAndUpdate(
    { key: "primary" },
    { $set: { email: profile.emailAddress || "", refreshTokenEnc: encrypt(refreshToken), connectedBy: String(connectedBy || ""), connectedAt: new Date(), lastError: "", lastErrorAt: null } },
    { upsert: true, new: true },
  );
  tokenCache = { token: refreshToken, at: Date.now() };
  return { email: profile.emailAddress || "" };
};

/** Which account is connected (never the token). */
const connectionStatus = async () => {
  const doc = await connectionModel().findOne({ key: "primary" }).lean();
  if (!doc || !doc.refreshTokenEnc) return { connected: false, source: "none", email: "", connectedAt: null, connectedBy: "", valid: null };
  let valid = true, error = "";
  try { await getProfile(); } catch (e) { valid = false; error = e.message; }
  return { connected: true, source: "database", email: doc.email || "", connectedAt: doc.connectedAt || null, connectedBy: doc.connectedBy || "", valid, ...(error ? { error } : {}) };
};

const disconnect = async () => {
  await connectionModel().deleteOne({ key: "primary" });
  tokenCache = null;
};

const gmailGet = async (client, endpoint, params = {}) => {
  try {
    const res = await client.request({ url: `${GMAIL_API}${endpoint}`, params });
    return res.data;
  } catch (e) {
    const apiMessage = e?.response?.data?.error?.message || e.message;
    const err = new Error(`Gmail API error: ${apiMessage}`);
    err.status = e?.response?.status === 401 || /invalid_grant/i.test(e.message) ? 401 : e?.response?.status || 502;
    throw err;
  }
};

const getProfile = async () => gmailGet(await authorizedClient(), "/profile");

/** Base64URL -> utf8 text. */
const decodeBase64Url = (data) => {
  if (!data) return "";
  try {
    return Buffer.from(String(data).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch (_) {
    return "";
  }
};

const htmlToText = (html) =>
  String(html || "")
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

/** Walks a MIME payload; collects text/plain and text/html parts (multipart-safe, never throws). */
const collectBodies = (part, acc = { plain: [], html: [] }) => {
  if (!part) return acc;
  const mime = String(part.mimeType || "").toLowerCase();
  const isAttachment = !!part.filename;
  if (!isAttachment && part.body?.data) {
    if (mime === "text/plain") acc.plain.push(decodeBase64Url(part.body.data));
    else if (mime === "text/html") acc.html.push(decodeBase64Url(part.body.data));
  }
  (part.parts || []).forEach((p) => collectBodies(p, acc));
  return acc;
};

const header = (msg, name) =>
  (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

/** Gmail API message -> plain summary. text/plain preferred, HTML only as a fallback. */
const parseMessage = (msg) => {
  const { plain, html } = collectBodies(msg.payload);
  const bodyText = plain.join("\n").trim() || htmlToText(html.join("\n")).trim();
  const internal = Number(msg.internalDate);
  const dateHeader = header(msg, "Date");
  const headerMs = Date.parse(dateHeader);
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: header(msg, "From"),
    to: header(msg, "To"),
    subject: header(msg, "Subject"),
    date: internal ? new Date(internal).toISOString() : header(msg, "Date"),
    dateHeader,
    messageIdHeader: header(msg, "Message-ID"), // to match a reply with the mail it answers
    inReplyTo: header(msg, "In-Reply-To"),
    labelIds: Array.isArray(msg.labelIds) ? msg.labelIds : [],
    // when the sender sent it: the Date header, else Gmail's own receive time
    sentAt: Number.isFinite(headerMs) ? new Date(headerMs).toISOString() : internal ? new Date(internal).toISOString() : "",
    snippet: msg.snippet || "",
    bodyText,
    bodySource: plain.join("").trim() ? "text/plain" : html.length ? "text/html" : "empty",
  };
};

/**
 * Only mail that was really SENT counts. A reply that is still a draft (typed in the compose box, not sent) is returned by the
 * Gmail API as part of the thread, so drafts — and anything in Trash or Spam — must never be read as a finance reply.
 */
const EXCLUDED_LABELS = ["DRAFT", "TRASH", "SPAM"];
const isUsableMessage = (m) => !(m && Array.isArray(m.labelIds) && m.labelIds.some((l) => EXCLUDED_LABELS.includes(l)));

/** Threads matching a Gmail search query: [{ id, snippet }]. */
const searchThreads = async (query, maxResults = 10) => {
  const data = await gmailGet(await authorizedClient(), "/threads", { q: query, maxResults });
  return data.threads || [];
};

/** Real Gmail API thread (id from threads.list, never the browser URL id), messages oldest first. */
const getThread = async (threadId) => {
  const data = await gmailGet(await authorizedClient(), `/threads/${encodeURIComponent(threadId)}`, { format: "full" });
  const all = (data.messages || []).map(parseMessage).sort((a, b) => new Date(a.date) - new Date(b.date));
  const messages = all.filter(isUsableMessage);
  return { id: data.id, subject: messages[0]?.subject || "", messages, ignoredMessages: all.filter((m) => !isUsableMessage(m)).map((m) => ({ id: m.id, labelIds: m.labelIds })) };
};

module.exports = {
  SCOPES,
  buildAuthUrl,
  exchangeCode,
  connectWithRefreshToken,
  connectionStatus,
  disconnect,
  getProfile,
  searchThreads,
  getThread,
  isUsableMessage,
  // exported for unit tests
  parseMessage,
  decodeBase64Url,
  htmlToText,
  encrypt,
  decrypt,
};
