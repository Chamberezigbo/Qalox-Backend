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

module.exports = processImage;
