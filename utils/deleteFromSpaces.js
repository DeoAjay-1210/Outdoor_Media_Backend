// utils/deleteFromSpaces.js
const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
const spacesClient = require('../config/spaces');

const getKeyFromUrl = (fileUrl) => {
  const bucketBase = process.env.DO_SPACES_CDN_BASE;

  if (!fileUrl.startsWith(bucketBase)) {
    // If it's a local URL, we don't delete from Spaces
    if (fileUrl.includes('localhost') || fileUrl.startsWith('http://localhost')) {
      return null;
    }
    throw new Error(`Invalid Spaces URL: ${fileUrl}`);
  }

  return fileUrl.replace(`${bucketBase}/`, '');
};

const deleteFromSpaces = async (fileUrl) => {
  const key = getKeyFromUrl(fileUrl);
  
  // Skip deletion for local URLs
  if (!key) {
    console.log('Skipping deletion for local file:', fileUrl);
    return;
  }

  const command = new DeleteObjectCommand({
    Bucket: process.env.DO_SPACES_BUCKET,
    Key: key,
  });

  await spacesClient.send(command);
};

module.exports = deleteFromSpaces;