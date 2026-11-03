/**
 * Documents uploaded against an employee: the PAN and Aadhaar scans.
 *
 * The bytes go to disk (src/utils/upload-storage.js); the database keeps the
 * FileUrl the API serves them from, plus what the upload said about itself.
 * One live document per type per employee - uploading again replaces it, and
 * the replaced file is removed from disk, because an ID scan nobody can reach
 * through the application is still an ID scan sitting on a server.
 *
 * Access is settled in the route file.
 */
import { randomUUID } from 'node:crypto';
import { query, queryOne, withTransaction } from '../helpers/query.helper.js';
import { EmployeeDocument, EMPLOYEE_DOCUMENT_PUBLIC_PROPS } from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import { storeEmployeeFile, removeStoredFile } from '../utils/upload-storage.js';
import { MESSAGES, ERROR_CODE } from '../enums/index.js';
import { assertEmployeeExists } from './employee.service.js';

const DOCUMENT_COLUMNS = EmployeeDocument.select(EMPLOYEE_DOCUMENT_PUBLIC_PROPS);

const OUTPUT_COLUMNS = EMPLOYEE_DOCUMENT_PUBLIC_PROPS.map(
  (prop) => `inserted.${EmployeeDocument.col(prop)} AS ${prop}`,
).join(', ');

/**
 * What the file actually is, read from its first bytes.
 *
 * The client's Content-Type and file extension are both whatever the client
 * says they are. The magic number is what the file is - so an .exe renamed
 * to pan.jpg is refused, and the type stored is one this server checked.
 */
const SIGNATURES = Object.freeze([
  { mimeType: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mimeType: 'image/png',
    ext: 'png',
    test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mimeType: 'image/webp',
    ext: 'webp',
    test: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
  { mimeType: 'application/pdf', ext: 'pdf', test: (b) => b.toString('ascii', 0, 5) === '%PDF-' },
]);

function detectFileType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  return SIGNATURES.find((signature) => signature.test(buffer)) ?? null;
}

function toPublic(row) {
  if (!row) return row;
  return {
    ...row,
    employeeDocumentId: Number(row.employeeDocumentId),
    employeeDetailId: Number(row.employeeDetailId),
  };
}

/** Every live document of one employee, or a 404 for the employee. */
export async function listDocuments(employeeDetailId) {
  await assertEmployeeExists(employeeDetailId);

  const rows = await query(
    `SELECT ${DOCUMENT_COLUMNS}
       FROM ${EmployeeDocument.table}
      WHERE EmployeeDetailId = @employeeDetailId AND DeletedAt IS NULL
      ORDER BY DocumentType`,
    EmployeeDocument.params({ employeeDetailId }),
  );

  return rows.map(toPublic);
}

/**
 * Stores a file as this employee's document of `documentType`, replacing any
 * live one.
 *
 * The file is written BEFORE the transaction and removed again if it fails:
 * the other order would commit a FileUrl that points at nothing whenever the
 * write failed. The old file goes only after the commit, so a rollback never
 * leaves the surviving row pointing at a deleted file.
 */
export async function uploadDocument(actorId, employeeDetailId, documentType, file) {
  await assertEmployeeExists(employeeDetailId);

  if (!file) {
    throw ApiError.badRequest(MESSAGES.FILE_REQUIRED, { code: ERROR_CODE.INVALID_FILE });
  }

  const kind = detectFileType(file.buffer);
  if (!kind) {
    throw ApiError.badRequest(MESSAGES.FILE_TYPE_NOT_ALLOWED, {
      code: ERROR_CODE.INVALID_FILE,
      allowed: SIGNATURES.map((signature) => signature.mimeType),
    });
  }

  // The name is ours, never the client's: an uploaded name is a path the
  // client chose, and a random one also stops the URL being guessable.
  const fileName = `${documentType.toLowerCase()}-${randomUUID()}.${kind.ext}`;
  const fileUrl = await storeEmployeeFile(employeeDetailId, fileName, file.buffer);

  let outcome;
  try {
    outcome = await withTransaction(async (run) => {
      const params = {
        ...EmployeeDocument.params({ employeeDetailId, documentType }),
        actorId: EmployeeDocument.param('modifiedBy', actorId),
      };

      const replaced = await run(
        `UPDATE ${EmployeeDocument.table}
            SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
         OUTPUT deleted.FileUrl AS fileUrl
          WHERE EmployeeDetailId = @employeeDetailId
            AND DocumentType = @documentType
            AND DeletedAt IS NULL`,
        params,
      );

      const [row] = await run(
        `INSERT INTO ${EmployeeDocument.table}
                (EmployeeDetailId, DocumentType, FileUrl, OriginalFileName, MimeType,
                 FileSizeBytes, CreatedBy, ModifiedBy)
         OUTPUT ${OUTPUT_COLUMNS}
         VALUES (@employeeDetailId, @documentType, @fileUrl, @originalFileName, @mimeType,
                 @fileSizeBytes, @actorId, @actorId)`,
        {
          ...params,
          ...EmployeeDocument.params({
            fileUrl,
            originalFileName: file.originalname ? file.originalname.slice(0, 255) : null,
            mimeType: kind.mimeType,
            fileSizeBytes: file.size,
          }),
        },
      );

      return { row, replacedUrl: replaced[0]?.fileUrl ?? null };
    });
  } catch (error) {
    await removeStoredFile(fileUrl);
    // Two uploads of the same type at once: the filtered unique index lets
    // one through, and the other is told to retry rather than shown a 500.
    if (error?.number === 2601 || error?.number === 2627) {
      throw ApiError.conflict(MESSAGES.MODIFIED_ELSEWHERE, { code: ERROR_CODE.MODIFIED_ELSEWHERE });
    }
    throw error;
  }

  if (outcome.replacedUrl) await removeStoredFile(outcome.replacedUrl);

  return toPublic(outcome.row);
}

/** Removes the live document of `documentType`, row and file both. */
export async function deleteDocument(actorId, employeeDetailId, documentType) {
  await assertEmployeeExists(employeeDetailId);

  const row = await queryOne(
    `UPDATE ${EmployeeDocument.table}
        SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
     OUTPUT deleted.EmployeeDocumentId AS employeeDocumentId,
            deleted.DocumentType       AS documentType,
            deleted.FileUrl            AS fileUrl
      WHERE EmployeeDetailId = @employeeDetailId
        AND DocumentType = @documentType
        AND DeletedAt IS NULL`,
    {
      ...EmployeeDocument.params({ employeeDetailId, documentType }),
      actorId: EmployeeDocument.param('modifiedBy', actorId),
    },
  );

  if (!row) {
    throw ApiError.notFound(MESSAGES.DOCUMENT_NOT_FOUND, { code: ERROR_CODE.DOCUMENT_NOT_FOUND });
  }

  await removeStoredFile(row.fileUrl);

  return { employeeDocumentId: Number(row.employeeDocumentId), documentType: row.documentType };
}
