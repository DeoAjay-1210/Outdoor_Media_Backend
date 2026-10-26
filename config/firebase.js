let admin = null;
let messaging = null;
let isFirebaseInitialized = false;

function initFirebase() {
  if (isFirebaseInitialized) return messaging;

  try {
    if (!admin) {
      try {
        admin = require("firebase-admin");
      } catch (e) {
        console.warn(
          "⚠️ [Firebase] 'firebase-admin' package is not installed yet. Run 'npm install' in Outdoor_Media_Backend."
        );
        return null;
      }
    }

    if (admin.apps.length > 0) {
      messaging = admin.messaging();
      isFirebaseInitialized = true;
      return messaging;
    }

    let credential = null;

    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        credential = admin.credential.cert(serviceAccount);
      } catch (jsonErr) {
        console.error("❌ [Firebase] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:", jsonErr.message);
      }
    } else if (
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
    ) {
      credential = admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      });
    }

    if (credential) {
      admin.initializeApp({ credential });
      messaging = admin.messaging();
      isFirebaseInitialized = true;
      // console.log("✅ Firebase Admin SDK initialized successfully.");
    } else {
      console.warn(
        "⚠️ [Firebase] Credentials not set in Outdoor_Media_Backend/.env. Please add FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY or FIREBASE_SERVICE_ACCOUNT_JSON."
      );
    }
  } catch (err) {
    console.error("❌ [Firebase] Initialization failed:", err.message);
  }

  return messaging;
}

function getMessaging() {
  if (!isFirebaseInitialized) {
    return initFirebase();
  }
  return messaging;
}

module.exports = {
  get admin() {
    if (!admin) {
      try {
        admin = require("firebase-admin");
      } catch (_) {}
    }
    return admin;
  },
  initFirebase,
  getMessaging,
};
