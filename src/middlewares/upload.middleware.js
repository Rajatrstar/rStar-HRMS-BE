/**
 * Accepts one multipart file into memory, as `req.file`.
 *
 *   router.put(path, guard, singleFileUpload('file'), controller.upload);
 *
 * Memory rather than multer's disk storage: the file is checked - employee
 * exists, the bytes really are an image or a PDF - before anything is
 * written, so a refused upload never leaves a file behind. The size limit is
 * what keeps that safe.
 *
 * multer reports its own failures as MulterError, which the error middleware
 * would treat as an unexpected 500. They are the client's mistakes, so they
 * are turned into a 400 here.
 */
import multer from 'multer';
import { env } from '../config/env.js';
import { ApiError } from '../utils/api-error.js';
import { MESSAGES, ERROR_CODE } from '../enums/index.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.UPLOAD_MAX_FILE_MB * 1024 * 1024,
    files: 1,
    fields: 10,
  },
  // Without this a file named "आधार.pdf" arrives as latin1 mojibake.
  defParamCharset: 'utf8',
});

export function singleFileUpload(field) {
  const handler = upload.single(field);

  return (req, res, next) =>
    handler(req, res, (error) => {
      if (!error) return next();
      if (!(error instanceof multer.MulterError)) return next(error);

      const message =
        error.code === 'LIMIT_FILE_SIZE'
          ? MESSAGES.FILE_TOO_LARGE
          : error.code === 'LIMIT_UNEXPECTED_FILE'
            ? MESSAGES.FILE_REQUIRED
            : MESSAGES.VALIDATION_FAILED;

      return next(
        ApiError.badRequest(message, {
          code: ERROR_CODE.INVALID_FILE,
          reason: error.code,
          maxFileMb: env.UPLOAD_MAX_FILE_MB,
        }),
      );
    });
}
