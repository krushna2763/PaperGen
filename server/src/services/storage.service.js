import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env.js';
import { Readable } from 'stream';

// Configure Cloudinary from centralized env
cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true
});

/**
 * Storage Service - Modular file storage abstraction
 */
export const storageService = {
  /**
   * Upload a PDF file buffer to Cloudinary
   * @param {Object} file - Multer file object (contains buffer, originalname, mimetype, size)
   * @returns {Promise<Object>} Normalized stored file metadata
   */
  async uploadPdf(file) {
    if (!file || !file.buffer) {
      throw new Error('Invalid file object provided to storage service');
    }

    if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
      throw new Error('Cloudinary credentials are not properly configured in environment');
    }

    // Clean filename for public_id
    const safeBaseName = file.originalname
      .replace(/\.[^/.]+$/, '') // remove extension
      .replace(/[^a-zA-Z0-9_-]/g, '_') // sanitize
      .substring(0, 50); // limit length
    
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e4)}`;
    const publicId = `paper_setting_ai/papers/${safeBaseName}_${uniqueSuffix}`;

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw', // Suitable for document files like PDFs
          public_id: publicId,
          tags: ['previous_year_paper', 'prototype'],
          overwrite: true
        },
        (error, result) => {
          if (error) {
            console.error('[Storage Service] Cloudinary upload failed:', error);
            return reject(new Error(`Failed to upload document to cloud storage: ${error.message}`));
          }

          resolve({
            url: result.secure_url || result.url,
            publicId: result.public_id,
            originalName: file.originalname,
            mimeType: file.mimetype || 'application/pdf',
            size: file.size,
            format: result.format || 'pdf',
            createdAt: result.created_at || new Date().toISOString()
          });
        }
      );

      // Pipe file buffer into the Cloudinary upload stream
      if (file.buffer) {
        Readable.from(file.buffer).pipe(uploadStream);
      } else {
        reject(new Error('File buffer is empty or unavailable'));
      }
    });
  },

  /**
   * SSRF guard: every fileUrl accepted from request bodies must point at the
   * configured Cloudinary delivery host — never an internal or arbitrary
   * remote address. With CLOUDINARY_CLOUD_NAME set, the URL must also target
   * that cloud's path (/<cloud>/...), so other tenants' URLs are rejected.
   * Throws a 400 with err.status so controllers' next(error) path reports it
   * cleanly. Fail closed: if no cloud is configured, all fileUrl downloads
   * are refused (uploads still work; clients should pass data inline instead).
   * @param {string} fileUrl
   */
  assertStorageFileUrl(fileUrl) {
    let parsed;
    try {
      parsed = new URL(fileUrl);
    } catch {
      const error = new Error('The provided file URL is malformed.');
      error.status = 400;
      throw error;
    }

    const allowedHost = env.CLOUDINARY_HOST || 'res.cloudinary.com';
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== allowedHost.toLowerCase()) {
      const error = new Error(
        `"fileUrl" must point at ${allowedHost} over HTTPS (got ${parsed.protocol}//${parsed.hostname}).`
      );
      error.status = 400;
      throw error;
    }

    const cloudName = (env.CLOUDINARY_CLOUD_NAME || '').trim();
    if (!cloudName) {
      const error = new Error(
        'fileUrl downloads are disabled because CLOUDINARY_CLOUD_NAME is not configured.'
      );
      error.status = 400;
      throw error;
    }

    // Cloudinary delivery paths start with /<cloud_name>/...
    const pathFirstSegment = parsed.pathname.split('/').filter(Boolean)[0] || '';
    if (pathFirstSegment !== cloudName) {
      const error = new Error(
        `"fileUrl" must reference this workspace's cloud "${cloudName}" (path segment mismatch).`
      );
      error.status = 400;
      throw error;
    }
  },

  /**
   * Download a remote file buffer from a URL (e.g. Cloudinary storage)
   * @param {string} fileUrl - Public URL of the stored file
   * @returns {Promise<Buffer>} Raw file buffer
   */
  async downloadFileBuffer(fileUrl) {
    if (!fileUrl || typeof fileUrl !== 'string') {
      const error = new Error('A valid file URL must be provided to download the document.');
      error.status = 400;
      throw error;
    }

    // SSRF guard BEFORE any network access. Every current caller is
    // request-facing, so the check is unconditional.
    this.assertStorageFileUrl(fileUrl);

    try {
      console.log(`[Storage Service] Fetching file buffer from: ${fileUrl}`);
      const response = await fetch(fileUrl);

      if (!response.ok) {
        const error = new Error(`Failed to download stored file from remote storage (HTTP ${response.status} ${response.statusText})`);
        error.status = response.status === 404 ? 404 : 502;
        throw error;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      console.log(`[Storage Service] Successfully downloaded file buffer (${buffer.length} bytes)`);
      return buffer;
    } catch (err) {
      if (err.status) throw err;
      console.error('[Storage Service] Download error:', err);
      const error = new Error(`Network error while downloading document: ${err.message}`);
      error.status = 502;
      throw error;
    }
  }
};

export default storageService;
