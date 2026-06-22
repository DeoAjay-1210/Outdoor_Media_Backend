const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const SECRET = process.env.OTP_SECRET || 'my_super_secret_key_123456789';
const KEY = crypto.createHash('sha256').update(SECRET).digest(); // 32 bytes

const encryptOtp = (otp) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);

  let encrypted = cipher.update(otp, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return `${iv.toString('hex')}:${encrypted}`;
};

const decryptOtp = (encryptedText) => {
  const [ivHex, encrypted] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
};

module.exports = { encryptOtp, decryptOtp };