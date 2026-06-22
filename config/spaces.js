// config/spaces.js
const { S3Client } = require('@aws-sdk/client-s3');

const spacesClient = new S3Client({
  region: process.env.DO_SPACES_REGION || "sgp1",
  endpoint: process.env.DO_SPACES_ENDPOINT || "https://sgp1.digitaloceanspaces.com",
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET,
  },
  forcePathStyle: false,
});

module.exports = spacesClient;