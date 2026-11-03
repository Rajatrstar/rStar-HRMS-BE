/**
 * The repeating sections of an employee profile: work experience, education
 * and dependents.
 *
 * ONE SERVICE FOR ALL THREE, driven by SECTIONS below, the way master data is
 * served. Each section is a list of rows hanging off one employee, and the
 * only differences between them are the columns and which master-data lists
 * they point at - so those are data here, not three copies of the same code.
 *
 * READ AS A LIST, SAVED AS A LIST. The profile screen edits a section as a
 * table - add a row, change one, remove one - and posts the whole table back.
 * saveSection() reconciles that against the database in one transaction:
 *
 *   row with its id     -> UPDATE that row
 *   row without an id   -> INSERT
 *   live row not posted -> soft delete
 *
 * so ids stay stable across saves, and a half-applied save cannot happen.
 * The alternative, an endpoint per row, makes the client sequence N calls and
 * leaves the section half-saved when the third one fails.
 *
 * Access is settled in the route file, as for the employee record itself.
 */
import { query, withTransaction } from '../helpers/query.helper.js';
import {
  EmployeeWorkExperience,
  EmployeeEducation,
  EmployeeDependent,
  Qualification,
  Specialization,
  Relationship,
} from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import { MESSAGES, ERROR_CODE, EMPLOYEE_SECTION } from '../enums/index.js';
import { assertEmployeeExists } from './employee.service.js';

/**
 * Everything that differs between the sections.
 *
 *   props    - the columns a save writes, in addition to the row's own id
 *   lookups  - master-data references: checked on save, and their names
 *              joined onto every row read, so the client shows "Spouse"
 *              rather than 4
 *   orderBy  - how the screen expects the rows, newest first where it means
 *              anything
 */
const SECTIONS = Object.freeze({
  [EMPLOYEE_SECTION.WORK_EXPERIENCE]: {
    model: EmployeeWorkExperience,
    idProp: 'employeeWorkExperienceId',
    props: ['companyName', 'jobTitle', 'fromDate', 'toDate', 'jobDescription', 'isRelevant'],
    lookups: [],
    orderBy: 's.FromDate DESC, s.EmployeeWorkExperienceId',
  },
  [EMPLOYEE_SECTION.EDUCATION]: {
    model: EmployeeEducation,
    idProp: 'employeeEducationId',
    props: [
      'instituteName',
      'qualificationId',
      'specializationId',
      'degree',
      'dateOfCompletion',
      'grade',
    ],
    lookups: [
      {
        idProp: 'qualificationId',
        model: Qualification,
        nameAs: 'qualificationName',
        message: MESSAGES.QUALIFICATION_NOT_FOUND,
      },
      {
        idProp: 'specializationId',
        model: Specialization,
        nameAs: 'specializationName',
        message: MESSAGES.SPECIALIZATION_NOT_FOUND,
      },
    ],
    orderBy: 's.DateOfCompletion DESC, s.EmployeeEducationId',
  },
  [EMPLOYEE_SECTION.DEPENDENTS]: {
    model: EmployeeDependent,
    idProp: 'employeeDependentId',
    props: ['name', 'relationshipId', 'dateOfBirth', 'gender', 'contactNumber'],
    lookups: [
      {
        idProp: 'relationshipId',
        model: Relationship,
        nameAs: 'relationshipName',
        message: MESSAGES.RELATIONSHIP_NOT_FOUND,
      },
    ],
    orderBy: 's.EmployeeDependentId',
  },
});

/** The section segments, for the route loop. */
export const SECTION_KEYS = Object.freeze(Object.keys(SECTIONS));

function sectionFor(key) {
  const section = SECTIONS[key];
  if (!section) throw new Error(`Unknown employee section "${key}".`);
  return section;
}

/** BIGINT ids arrive as strings; see withNumericIds in employee.service.js. */
function withNumericIds(section, row) {
  const copy = { ...row };
  for (const prop of [section.idProp, 'employeeDetailId', ...section.lookups.map((l) => l.idProp)]) {
    if (copy[prop] !== undefined && copy[prop] !== null) copy[prop] = Number(copy[prop]);
  }
  return copy;
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

async function readRows(section, employeeDetailId) {
  const { model } = section;
  const columns = [section.idProp, 'employeeDetailId', ...section.props, 'modifiedAt']
    .map((prop) => `s.${model.col(prop)} AS ${prop}`)
    .concat(section.lookups.map((lookup, i) => `j${i}.${lookup.model.col('name')} AS ${lookup.nameAs}`))
    .join(', ');

  const joins = section.lookups
    .map(
      (lookup, i) =>
        `LEFT JOIN ${lookup.model.table} AS j${i}
           ON j${i}.${lookup.model.col(lookup.idProp)} = s.${model.col(lookup.idProp)}`,
    )
    .join('\n       ');

  const rows = await query(
    `SELECT ${columns}
       FROM ${model.table} AS s
       ${joins}
      WHERE s.EmployeeDetailId = @employeeDetailId AND s.DeletedAt IS NULL
      ORDER BY ${section.orderBy}`,
    model.params({ employeeDetailId }),
  );

  return rows.map((row) => withNumericIds(section, row));
}

/** Every live row of one section for one employee, or a 404 for the employee. */
export async function listSection(key, employeeDetailId) {
  const section = sectionFor(key);
  await assertEmployeeExists(employeeDetailId);
  return readRows(section, employeeDetailId);
}

/* -------------------------------------------------------------------------- */
/* Write                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every master-data id the rows name must exist and not be deleted - the same
 * rule, and the same reason, as assertMasterDataUsable in employee.service.js:
 * a stale id would otherwise come back from the foreign key as a 500.
 * One query per list, however many rows name it.
 */
async function assertLookupsUsable(section, rows) {
  for (const lookup of section.lookups) {
    const ids = [...new Set(rows.map((row) => row[lookup.idProp]).filter((id) => id != null))];
    if (ids.length === 0) continue;

    const params = Object.fromEntries(
      ids.map((id, i) => [`id${i}`, lookup.model.param(lookup.idProp, id)]),
    );
    const found = await query(
      `SELECT ${lookup.model.col(lookup.idProp)} AS id
         FROM ${lookup.model.table}
        WHERE ${lookup.model.col(lookup.idProp)} IN (${ids.map((_, i) => `@id${i}`).join(', ')})
          AND ${lookup.model.col('deletedAt')} IS NULL`,
      params,
    );

    if (found.length !== ids.length) {
      throw ApiError.badRequest(lookup.message, {
        code: ERROR_CODE.MASTER_DATA_NOT_FOUND,
        field: lookup.idProp,
      });
    }
  }
}

/**
 * Replaces one section with the rows given, and returns the section as saved.
 *
 * `rows` is already validated by the controller. A row carrying its id must
 * be a live row of THIS employee's section: an id from another employee, or
 * one already removed in another tab, is refused rather than quietly turned
 * into an insert - which would duplicate the row the user thought they edited.
 */
export async function saveSection(key, actorId, employeeDetailId, rows) {
  const section = sectionFor(key);
  const { model, idProp, props } = section;

  await assertEmployeeExists(employeeDetailId);
  await assertLookupsUsable(section, rows);

  await withTransaction(async (run) => {
    const live = await run(
      `SELECT ${model.col(idProp)} AS id
         FROM ${model.table} WITH (UPDLOCK, HOLDLOCK)
        WHERE EmployeeDetailId = @employeeDetailId AND DeletedAt IS NULL`,
      model.params({ employeeDetailId }),
    );
    const liveIds = new Set(live.map((row) => Number(row.id)));

    const kept = rows.filter((row) => row[idProp] !== undefined).map((row) => row[idProp]);
    const unknown = kept.filter((id) => !liveIds.has(id));
    if (unknown.length > 0 || new Set(kept).size !== kept.length) {
      throw ApiError.badRequest(MESSAGES.SECTION_ROW_NOT_FOUND, {
        code: ERROR_CODE.SECTION_ROW_NOT_FOUND,
        [idProp]: unknown,
      });
    }

    const actor = model.param('modifiedBy', actorId);

    // Removed rows first: nothing here is unique per employee, but doing the
    // deletes before the inserts is what keeps that true if a section ever
    // grows a unique index.
    const keptParams = Object.fromEntries(kept.map((id, i) => [`keep${i}`, model.param(idProp, id)]));
    await run(
      `UPDATE ${model.table}
          SET DeletedAt = SYSUTCDATETIME(), ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
        WHERE EmployeeDetailId = @employeeDetailId AND DeletedAt IS NULL
          ${kept.length > 0 ? `AND ${model.col(idProp)} NOT IN (${kept.map((_, i) => `@keep${i}`).join(', ')})` : ''}`,
      { ...model.params({ employeeDetailId }), ...keptParams, actorId: actor },
    );

    const writable = (row) =>
      model.params(Object.fromEntries(props.map((prop) => [prop, row[prop] ?? null])));

    for (const row of rows) {
      if (row[idProp] !== undefined) {
        await run(
          `UPDATE ${model.table}
              SET ${props.map((prop) => `${model.col(prop)} = @${prop}`).join(', ')},
                  ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
            WHERE ${model.col(idProp)} = @rowId AND EmployeeDetailId = @employeeDetailId`,
          {
            ...writable(row),
            ...model.params({ employeeDetailId }),
            rowId: model.param(idProp, row[idProp]),
            actorId: actor,
          },
        );
      } else {
        await run(
          `INSERT INTO ${model.table}
                  (EmployeeDetailId, ${props.map((prop) => model.col(prop)).join(', ')}, CreatedBy, ModifiedBy)
           VALUES (@employeeDetailId, ${props.map((prop) => `@${prop}`).join(', ')}, @actorId, @actorId)`,
          { ...writable(row), ...model.params({ employeeDetailId }), actorId: actor },
        );
      }
    }
  });

  return readRows(section, employeeDetailId);
}
