const fs = require("fs");
const path = require("path");
const r2Service = require("../Services/R2Service");

/**
 * Where marketers' identity documents live.
 *
 * They used to be written to a folder on the server's own disk. On a host that
 * rebuilds its container for every deploy that disk is wiped each time, which
 * left every "Approved" document pointing at a file that no longer existed and
 * the Super Admin viewer showing a broken image. They now go to Cloudflare R2,
 * the same private bucket as passports and logos.
 *
 * The stored value says where a file is:
 *   "r2:kyc/<name>"   in R2 (everything uploaded from now on)
 *   "<name>"          on the server's disk (older uploads, if they survived)
 * so existing rows keep working and nothing needs migrating.
 */

const LEGACY_DIR = path.join(__dirname, "..", "uploads-private", "kyc");
const R2_PREFIX = "r2:";

const CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".pdf": "application/pdf",
};

/** Content type from the stored name's extension; unknown types download rather than render. */
const contentTypeOf = (stored) => CONTENT_TYPES[path.extname(String(stored)).toLowerCase()] || "application/octet-stream";

/**
 * Stores a document and returns the value to save in the database.
 * Throws if the upload fails, so the caller can refuse the request rather than
 * save a record whose file was never stored.
 *
 * @param {{ buffer: Buffer, filename: string, contentType: string }} input
 * @returns {Promise<string>}
 */
async function saveKycFile({ buffer, filename, contentType }) {
  const key = `kyc/${filename}`;
  await r2Service.uploadObject({ buffer, key, contentType });
  return `${R2_PREFIX}${key}`;
}

/**
 * Reads a stored document.
 * @param {string} stored the value saved in the database
 * @returns {Promise<{ buffer: Buffer, contentType: string } | null>} null when the file no longer exists
 */
async function readKycFile(stored) {
  if (typeof stored === "string" && stored.startsWith(R2_PREFIX)) {
    try {
      return { buffer: await r2Service.getObjectBuffer(stored.slice(R2_PREFIX.length)), contentType: contentTypeOf(stored) };
    } catch (error) {
      // A missing object is "no longer there"; anything else (credentials, network) is a real failure.
      if (error?.name === "NoSuchKey" || error?.Code === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }

  // basename() keeps a stored value from ever reaching outside the folder.
  const filePath = path.join(LEGACY_DIR, path.basename(String(stored)));
  try {
    return { buffer: await fs.promises.readFile(filePath), contentType: contentTypeOf(stored) };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Removes a stored document. Never throws: a file left behind is harmless. */
async function deleteKycFile(stored) {
  try {
    if (typeof stored === "string" && stored.startsWith(R2_PREFIX)) {
      await r2Service.deleteObject(stored.slice(R2_PREFIX.length));
    } else if (stored) {
      await fs.promises.unlink(path.join(LEGACY_DIR, path.basename(String(stored))));
    }
  } catch {
    // Best effort.
  }
}

module.exports = { saveKycFile, readKycFile, deleteKycFile, contentTypeOf, R2_PREFIX };
