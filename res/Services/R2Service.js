const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const logger = require("../config/logger");

/**
 * Cloudflare R2 storage, accessed via its S3-compatible API. The bucket is
 * private — nothing is served from a public URL. Every read goes through a
 * presigned GET URL generated on demand, so a stale/leaked URL stops working
 * once R2_PRESIGNED_URL_EXPIRY_SECONDS elapses.
 */

let client = null;
const getClient = () => {
  if (client) return client;

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null);

  if (!accessKeyId || !secretAccessKey || !endpoint) {
    throw new Error("R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_ENDPOINT (or R2_ACCOUNT_ID) must be set in the environment");
  }

  client = new S3Client({
    region: "auto", // R2 ignores region but the SDK requires one
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
  return client;
};

const getBucket = () => {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error("R2_BUCKET_NAME must be set in the environment");
  return bucket;
};

/**
 * Upload a buffer to R2 under the given key.
 * @param {{buffer: Buffer, key: string, contentType: string}} params
 * @returns {Promise<string>} the object key (what gets stored in the DB, not a URL)
 */
const uploadObject = async ({ buffer, key, contentType }) => {
  const s3 = getClient();
  await s3.send(new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  logger.info("[R2] Object uploaded", { key });
  return key;
};

/**
 * Generate a time-limited presigned GET URL for a stored object.
 * @param {string} key
 * @returns {Promise<string>}
 */
const getPresignedUrl = async (key) => {
  const s3 = getClient();
  const expiresIn = parseInt(process.env.R2_PRESIGNED_URL_EXPIRY_SECONDS, 10) || 3600;
  const command = new GetObjectCommand({ Bucket: getBucket(), Key: key });
  return getSignedUrl(s3, command, { expiresIn });
};

/**
 * Permanently delete a stored object. Used by retention cleanup — never
 * called on a hot read/write path.
 * @param {string} key
 */
const deleteObject = async (key) => {
  const s3 = getClient();
  await s3.send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }));
  logger.info("[R2] Object deleted", { key });
};

/**
 * Download a stored object's raw bytes. Used by one-off backfill/processing
 * scripts that need the actual file content, not just a URL to it.
 * @param {string} key
 * @returns {Promise<Buffer>}
 */
const getObjectBuffer = async (key) => {
  const s3 = getClient();
  const response = await s3.send(new GetObjectCommand({ Bucket: getBucket(), Key: key }));
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

module.exports = { uploadObject, getPresignedUrl, deleteObject, getObjectBuffer };
