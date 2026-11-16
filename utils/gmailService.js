/**
 * Gmail (read-only) service — official Gmail REST API through google-auth-library.
 *
 * Scope is gmail.readonly ONLY (no send / modify / delete). Credentials come from the
 * environment (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI,
 * GOOGLE_REFRESH_TOKEN); nothing here logs or returns a secret.
 */
const fs = require("fs");
const path = require("path");
const { OAuth2Client } = require("google-auth-library");

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const ENV_PATH = path.join(__dirname, "..", ".env");

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

/** Sets KEY=value in .env (replacing the line, or appending) and in the running process. */
const saveEnvValue = (key, value) => {
  let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  env = re.test(env) ? env.replace(re, () => line) : env.replace(/\s*$/, "\n") + line + "\n";
  fs.writeFileSync(ENV_PATH, env);
  process.env[key] = value;
};

const authorizedClient = () => {
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    const err = new Error("Gmail is not authorized yet (GOOGLE_REFRESH_TOKEN is empty). Run the OAuth flow first.");
    err.status = 409;
    throw err;
  }
  const client = createClient();
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return client;
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

const getProfile = async () => gmailGet(authorizedClient(), "/profile");

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
  const data = await gmailGet(authorizedClient(), "/threads", { q: query, maxResults });
  return data.threads || [];
};

/** Real Gmail API thread (id from threads.list, never the browser URL id), messages oldest first. */
const getThread = async (threadId) => {
  const data = await gmailGet(authorizedClient(), `/threads/${encodeURIComponent(threadId)}`, { format: "full" });
  const all = (data.messages || []).map(parseMessage).sort((a, b) => new Date(a.date) - new Date(b.date));
  const messages = all.filter(isUsableMessage);
  return { id: data.id, subject: messages[0]?.subject || "", messages, ignoredMessages: all.filter((m) => !isUsableMessage(m)).map((m) => ({ id: m.id, labelIds: m.labelIds })) };
};

module.exports = {
  SCOPES,
  buildAuthUrl,
  exchangeCode,
  saveEnvValue,
  getProfile,
  searchThreads,
  getThread,
  isUsableMessage,
  // exported for unit tests
  parseMessage,
  decodeBase64Url,
  htmlToText,
};
