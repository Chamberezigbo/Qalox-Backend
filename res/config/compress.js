const sharp = require("sharp");
const fs = require("fs").promises;
const path = require("path");

// Allowed MIME types
const allowedMimeTypes = ["image/jpeg", "image/png", "image/jpg"];

const processImage = async (buffer, folder, filename) => {
  const outputDir = path.join(__dirname, "..", "uploads", folder);
  const filePath = path.join(outputDir, filename);

  // Ensure the output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  try {
    // Use sharp metadata to validate the image buffer
    const metadata = await sharp(buffer).metadata();

    if (!allowedMimeTypes.includes(`image/${metadata.format}`)) {
      throw new Error("Invalid image format");
    }

    // Process the image
    await sharp(buffer)
      .resize(800, 800, { fit: "inside" }) // Resize within 800x800
      .toFormat("jpeg", { quality: 80 }) // Convert to JPEG with 80% quality
      .toFile(filePath);

    return `/uploads/${folder}/${filename}`; // Return the URL
  } catch (err) {
    console.error("Error processing image:", err.message);
    throw new Error("Image processing failed");
  }
};

/**
 * Same validation/resize/convert as processImage, but returns the processed
 * buffer instead of writing to local disk — for callers uploading to R2.
 * @param {Buffer} buffer
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
const processImageToBuffer = async (buffer) => {
  try {
    const metadata = await sharp(buffer).metadata();

    if (!allowedMimeTypes.includes(`image/${metadata.format}`)) {
      throw new Error("Invalid image format");
    }

    const processedBuffer = await sharp(buffer)
      .resize(800, 800, { fit: "inside" })
      .toFormat("jpeg", { quality: 80 })
      .toBuffer();

    return { buffer: processedBuffer, contentType: "image/jpeg" };
  } catch (err) {
    console.error("Error processing image:", err.message);
    throw new Error("Image processing failed");
  }
};

/**
 * Picks a representative "brand color" out of a logo image, for re-theming
 * the frontend away from the default indigo. Runs on the ORIGINAL uploaded
 * buffer, not the JPEG-converted one from processImageToBuffer — a
 * transparent PNG's background gets flattened to black by that conversion,
 * which would otherwise get picked up as the "dominant" color.
 *
 * Approach: downscale to a small raw RGBA grid, discard pixels that are
 * transparent or low-saturation (white/black/gray — including the
 * anti-aliased gray edge pixels a resize creates around solid black-on-white
 * text, which would otherwise get bucketed as a fake "color"), then bucket
 * the rest into a coarse color histogram and return the most common bucket.
 * No new dependency — sharp already does the decode/resize/raw-pixel work.
 *
 * @param {Buffer} buffer - the original (pre-conversion) uploaded image buffer
 * @returns {Promise<string|null>} a "#rrggbb" hex string, or null if no
 *   qualifying pixel was found (e.g. a pure black-on-white logo) — callers
 *   should leave the stored brand color unset in that case.
 */
const extractDominantColor = async (buffer) => {
  try {
    const { data, info } = await sharp(buffer)
      .resize(64, 64, { fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const buckets = new Map();
    const BUCKET_SIZE = 24;

    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      if (a < 128) continue; // transparent — not part of the visible mark

      // Low chroma = grayscale-ish (white, black, or any gray in between,
      // including anti-aliased edges between the two) — not a real color.
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (chroma < 20) continue;

      const key = [
        Math.round(r / BUCKET_SIZE) * BUCKET_SIZE,
        Math.round(g / BUCKET_SIZE) * BUCKET_SIZE,
        Math.round(b / BUCKET_SIZE) * BUCKET_SIZE,
      ].join(",");

      buckets.set(key, (buckets.get(key) || 0) + 1);
    }

    if (buckets.size === 0) return null;

    let bestKey = null;
    let bestCount = -1;
    for (const [key, count] of buckets) {
      if (count > bestCount) {
        bestCount = count;
        bestKey = key;
      }
    }

    const [r, g, b] = bestKey.split(",").map(Number);
    const toHex = (n) => Math.min(255, Math.max(0, n)).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  } catch (err) {
    console.error("Error extracting dominant color:", err.message);
    return null;
  }
};

module.exports = processImage;
module.exports.processImageToBuffer = processImageToBuffer;
module.exports.extractDominantColor = extractDominantColor;
