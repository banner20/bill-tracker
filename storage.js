'use strict';

// Image/PDF storage on Cloudinary. Configured via CLOUDINARY_URL
// (cloudinary://<api_key>:<api_secret>@<cloud_name>), which the Cloudinary SDK
// reads automatically from the environment.

const cloudinary = require('cloudinary').v2;

const enabled = () => !!process.env.CLOUDINARY_URL;

// Upload a file buffer; returns { url, public_id }.
function upload(buffer, { folder = 'bill-tracker', mime = '' } = {}) {
  return new Promise((resolve, reject) => {
    const isPdf = mime === 'application/pdf';
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: isPdf ? 'image' : 'image' }, // image works for both png/jpg; pdf via image w/ pages
      (err, result) => {
        if (err) return reject(err);
        resolve({ url: result.secure_url, public_id: result.public_id });
      }
    );
    stream.end(buffer);
  });
}

async function destroy(publicId) {
  if (!publicId) return;
  try { await cloudinary.uploader.destroy(publicId); } catch (e) { /* ignore */ }
}

module.exports = { enabled, upload, destroy };
