import multer from 'multer';
import path from 'path';

// Store in memory buffer for streaming to cloud storage
const storage = multer.memoryStorage();

// Maximum allowed PDF file size: 15 MB
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;

// File filter to strictly enforce PDF format
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const isPdfExt = ext === '.pdf';
  const isPdfMime = file.mimetype === 'application/pdf' || file.mimetype === 'application/x-pdf';

  if (isPdfExt && isPdfMime) {
    return cb(null, true);
  }

  const error = new Error('Only PDF files (.pdf) are allowed.');
  error.code = 'INVALID_FILE_TYPE';
  error.status = 400;
  return cb(error, false);
};

export const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1
  },
  fileFilter
});

/**
 * Middleware wrapper to handle Multer errors gracefully
 */
export const handleUploadMiddleware = (req, res, next) => {
  const uploadSingle = upload.single('file');

  uploadSingle(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            success: false,
            message: `File too large. Maximum allowed size is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB.`
          });
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({
            success: false,
            message: 'Unexpected field name. The file must be uploaded under the field name "file".'
          });
        }
        return res.status(400).json({
          success: false,
          message: `Upload error: ${err.message}`
        });
      }

      if (err.code === 'INVALID_FILE_TYPE') {
        return res.status(400).json({
          success: false,
          message: err.message
        });
      }

      return res.status(400).json({
        success: false,
        message: err.message || 'Error processing uploaded file'
      });
    }

    next();
  });
};

export default handleUploadMiddleware;
