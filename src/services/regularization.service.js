/**
 * Regularization: correcting a day that was recorded wrongly.
 *
 * Section 17 of docs/ATTENDANCE-LEAVE.html. Raised within a window - 24
 * hours by default, configurable - and approved by the reporting manager,
 * HR Admin or Admin.
 *
 * WHY APPROVAL WRITES A PUNCH RATHER THAN A STATUS. An approved correction
 * inserts the missing punch with Source = SYSTEM and CreatedBy set to the
 * approver, then hands the day to recomputeDay(). The day's verdict is
 * therefore reached the same way it always is, from punches - so a
 * regularized day and an ordinary one are computed by the same code and
 * cannot disagree about what six hours means.
 *
 * The alternative - setting the status directly - would make approval a
 * second, parallel way to decide a day, and the two would drift the first
 * time the shift's full-day minutes changed.
 *
 * PreviousAttendanceStatusId is captured before any of that, which is what
 * makes the change auditable afterwards.
 */
import { query, queryOne, withTransaction } from '../helpers/query.helper.js';
import {
  RegularizationRequest,
  AttendanceDay,
  AttendancePunch,
  AttendanceStatus,
  EmployeeDetails,
  RegularizationType,
  REGULARIZATION_REQUEST_PUBLIC_PROPS,
} from '../models/index.js';
import { ApiError } from '../utils/api-error.js';
import {
  MESSAGES,
  ERROR_CODE,
  REGULARIZATION_STATUS,
  ATTENDANCE_STATUS,
  PUNCH_TYPE,
  PUNCH_SOURCE,
} from '../enums/index.js';
import { env } from '../config/env.js';
import { dateOf, today } from '../helpers/date.helper.js';
import { ensureDay, recomputeDay, dayDetail } from './attendance.service.js';

const REQUEST_COLUMNS = RegularizationRequest.select(REGULARIZATION_REQUEST_PUBLIC_PROPS);
const OUTPUT_REQUEST = REGULARIZATION_REQUEST_PUBLIC_PROPS.map(
  (p) => `inserted.${RegularizationRequest.col(p)} AS ${p}`,
).join(', ');

const ID_PROPS = Object.freeze([
  'regularizationRequestId',
  'employeeDetailId',
  'attendanceDayId',
  'regularizationTypeId',
  'approvedBy',
]);

function shape(row) {
  if (!row) return row;
  const copy = { ...row };
  for (const prop of ID_PROPS) {
    if (copy[prop] !== undefined && copy[prop] !== null) copy[prop] = Number(copy[prop]);
  }
  if (copy.attendanceDate !== undefined && copy.attendanceDate !== null) {
    copy.attendanceDate = dateOf(copy.attendanceDate);
  }
  return copy;
}

const shapeAll = (rows) => rows.map(shape);

/* -------------------------------------------------------------------------
   Raising one
   ------------------------------------------------------------------------- */

/**
 * The deadline for correcting a day, captured when the request is raised.
 *
 * STORED ON THE ROW, not computed on read. If HR widened the window from 24
 * to 48 hours next month, a computed deadline would retrospectively revive
 * every request that had already expired - and narrowing it would expire
 * requests somebody submitted in good time. The rule that applied when they
 * submitted is the rule that should judge them.
 */
function deadlineFor(attendanceDate) {
  // Measured from the END of the day being corrected, not from the moment
  // of submission: "within 24 hours" of a day means the day after it, and
  // measuring from submission would make the window depend on itself.
  const endOfDay = new Date(`${attendanceDate}T23:59:59Z`);
  return new Date(endOfDay.getTime() + env.REGULARIZATION_WINDOW_HOURS * 3_600_000);
}

export async function createRequest(actorId, employeeDetailId, input) {
  const attendanceDate = input.attendanceDate;

  if (attendanceDate > today()) {
    // Correcting a day that has not happened is not a correction.
    throw ApiError.badRequest(MESSAGES.ATTENDANCE_DATE_RANGE, {
      code: ERROR_CODE.INVALID_DATE_RANGE,
    });
  }

  const deadline = deadlineFor(attendanceDate);
  if (Date.now() > deadline.getTime()) {
    throw ApiError.conflict(MESSAGES.REGULARIZATION_WINDOW_CLOSED, {
      code: ERROR_CODE.REGULARIZATION_WINDOW_CLOSED,
      deadline: deadline.toISOString(),
      windowHours: env.REGULARIZATION_WINDOW_HOURS,
    });
  }

  const type = await queryOne(
    `SELECT RegularizationTypeId AS regularizationTypeId FROM ${RegularizationType.table}
      WHERE RegularizationTypeId = @regularizationTypeId AND DeletedAt IS NULL AND IsActive = 1`,
    RegularizationType.params({ regularizationTypeId: input.regularizationTypeId }),
  );
  if (!type) {
    throw ApiError.badRequest(MESSAGES.REGULARIZATION_TYPE_NOT_FOUND, {
      code: ERROR_CODE.MASTER_DATA_NOT_FOUND,
    });
  }

  // The day may not exist yet - a date nobody punched on has no row until
  // the nightly close runs. The approval creates one if so.
  const existingDay = shape(
    await queryOne(
      `SELECT AttendanceDayId AS attendanceDayId FROM ${AttendanceDay.table}
        WHERE EmployeeDetailId = @employeeDetailId AND AttendanceDate = @attendanceDate
          AND DeletedAt IS NULL`,
      AttendanceDay.params({ employeeDetailId, attendanceDate }),
    ),
  );

  try {
    const row = await queryOne(
      `INSERT INTO ${RegularizationRequest.table}
              (EmployeeDetailId, AttendanceDate, AttendanceDayId, RegularizationTypeId,
               RequestedCheckInAt, RequestedCheckOutAt, Reason, Status, SubmissionDeadline,
               CreatedBy, ModifiedBy)
       OUTPUT ${OUTPUT_REQUEST}
       VALUES (@employeeDetailId, @attendanceDate, @attendanceDayId, @regularizationTypeId,
               @requestedCheckInAt, @requestedCheckOutAt, @reason, @status, @submissionDeadline,
               @actorId, @actorId)`,
      {
        ...RegularizationRequest.params({
          employeeDetailId,
          attendanceDate,
          attendanceDayId: existingDay?.attendanceDayId ?? null,
          regularizationTypeId: input.regularizationTypeId,
          requestedCheckInAt: input.requestedCheckInAt ?? null,
          requestedCheckOutAt: input.requestedCheckOutAt ?? null,
          reason: input.reason,
          status: REGULARIZATION_STATUS.PENDING,
          submissionDeadline: deadline,
        }),
        actorId: RegularizationRequest.param('createdBy', actorId),
      },
    );
    return shape(row);
  } catch (error) {
    // UQ_..._Employee_Date_Open is filtered to PENDING and APPROVED, so this
    // fires only when a live request already covers the day - a rejected one
    // deliberately leaves the slot free for a better-argued resubmission.
    if (error?.number === 2601 || error?.number === 2627) {
      throw ApiError.conflict(MESSAGES.REGULARIZATION_ALREADY_OPEN, {
        code: ERROR_CODE.REGULARIZATION_ALREADY_OPEN,
      });
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------
   Reading
   ------------------------------------------------------------------------- */

export async function listForEmployee(employeeDetailId, { status = null } = {}) {
  return shapeAll(
    await query(
      `SELECT ${REQUEST_COLUMNS} FROM ${RegularizationRequest.table}
        WHERE EmployeeDetailId = @employeeDetailId AND DeletedAt IS NULL
          AND (@status IS NULL OR Status = @status)
        ORDER BY AttendanceDate DESC`,
      RegularizationRequest.params({ employeeDetailId, status }),
    ),
  );
}

/**
 * The approver's queue.
 *
 * `managerId` narrows to one manager's reports; omitting it is the HR view.
 * The employee's name is joined in because a queue of ids is unusable, and
 * a second call per row to resolve them would be the classic N+1.
 */
export async function listPending({ managerId = null } = {}) {
  return shapeAll(
    await query(
      `SELECT ${REGULARIZATION_REQUEST_PUBLIC_PROPS.map((p) => `r.${RegularizationRequest.col(p)} AS ${p}`).join(', ')},
              e.FirstName    AS firstName,
              e.LastName     AS lastName,
              e.EmployeeCode AS employeeCode,
              t.Name         AS regularizationTypeName
         FROM ${RegularizationRequest.table} AS r
         JOIN ${EmployeeDetails.table}       AS e ON e.EmployeeDetailId = r.EmployeeDetailId
         JOIN ${RegularizationType.table}    AS t
           ON t.RegularizationTypeId = r.RegularizationTypeId
        WHERE r.Status = @pending AND r.DeletedAt IS NULL
          AND e.DeletedAt IS NULL
          AND (@managerId IS NULL OR e.ManagerId = @managerId)
        ORDER BY r.CreatedAt`,
      {
        pending: RegularizationRequest.param('status', REGULARIZATION_STATUS.PENDING),
        managerId: EmployeeDetails.param('managerId', managerId),
      },
    ),
  );
}

export async function getRequest(regularizationRequestId) {
  const row = shape(
    await queryOne(
      `SELECT ${REQUEST_COLUMNS} FROM ${RegularizationRequest.table}
        WHERE RegularizationRequestId = @regularizationRequestId AND DeletedAt IS NULL`,
      RegularizationRequest.params({ regularizationRequestId }),
    ),
  );
  if (!row) {
    throw ApiError.notFound(MESSAGES.REGULARIZATION_NOT_FOUND, {
      code: ERROR_CODE.REGULARIZATION_NOT_FOUND,
    });
  }
  return row;
}

/* -------------------------------------------------------------------------
   Deciding
   ------------------------------------------------------------------------- */

/**
 * Approve: write the missing punches, then let the day recompute itself.
 *
 * Nobody may approve their own request, whatever rights they hold. A
 * manager who is also somebody's report is a normal arrangement; a manager
 * who signs off their own missing check-out is not, and the module right
 * alone cannot tell the two apart.
 */
export async function approve(actorId, regularizationRequestId, { remarks = null } = {}) {
  const request = await getRequest(regularizationRequestId);

  if (request.status !== REGULARIZATION_STATUS.PENDING) {
    throw ApiError.conflict(MESSAGES.REGULARIZATION_NOT_PENDING, {
      code: ERROR_CODE.REGULARIZATION_NOT_PENDING,
      status: request.status,
    });
  }
  if (Number(request.employeeDetailId) === Number(actorId)) {
    throw ApiError.forbidden(MESSAGES.REGULARIZATION_SELF_APPROVAL, {
      code: ERROR_CODE.LEAVE_SELF_APPROVAL,
    });
  }

  const day = await ensureDay(request.employeeDetailId, request.attendanceDate, { actorId });

  await withTransaction(async (run) => {
    // Captured BEFORE the recompute changes it - this is the audit trail.
    await run(
      `UPDATE ${RegularizationRequest.table}
          SET Status                     = @approved,
              AttendanceDayId            = @attendanceDayId,
              PreviousAttendanceStatusId = @previousStatusId,
              ApprovedBy                 = @actorId,
              ApprovedAt                 = SYSUTCDATETIME(),
              ApproverRemarks            = @remarks,
              ModifiedBy                 = @actorId,
              ModifiedAt                 = SYSUTCDATETIME()
        WHERE RegularizationRequestId = @regularizationRequestId`,
      {
        ...RegularizationRequest.params({
          regularizationRequestId,
          attendanceDayId: day.attendanceDayId,
          previousAttendanceStatusId: day.attendanceStatusId,
          approverRemarks: remarks,
        }),
        approved: RegularizationRequest.param('status', REGULARIZATION_STATUS.APPROVED),
        previousStatusId: RegularizationRequest.param(
          'previousAttendanceStatusId',
          day.attendanceStatusId,
        ),
        remarks: RegularizationRequest.param('approverRemarks', remarks),
        actorId: RegularizationRequest.param('approvedBy', actorId),
      },
    );

    /*
      The punches themselves. Source = SYSTEM and CreatedBy = the approver,
      so the punch carries who vouched for it - which is the whole audit
      story for a time nobody actually recorded at the time.
    */
    for (const [type, at] of [
      [PUNCH_TYPE.IN, request.requestedCheckInAt],
      [PUNCH_TYPE.OUT, request.requestedCheckOutAt],
    ]) {
      if (!at) continue;

      await run(
        `INSERT INTO ${AttendancePunch.table}
                (AttendanceDayId, PunchType, PunchAt, Source, Remarks, CreatedBy)
         VALUES (@attendanceDayId, @punchType, @punchAt, @source, @remarks, @actorId)`,
        {
          ...AttendancePunch.params({
            attendanceDayId: day.attendanceDayId,
            punchType: type,
            punchAt: at,
            source: PUNCH_SOURCE.SYSTEM,
            remarks: `Regularization #${regularizationRequestId}`,
          }),
          actorId: AttendancePunch.param('createdBy', actorId),
        },
      );
    }

    // Set before the recompute, which reads it and keeps the REGULARIZED
    // badge on the day rather than relabelling it as an ordinary present.
    await run(
      `UPDATE ${AttendanceDay.table}
          SET IsRegularized = 1, ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
        WHERE AttendanceDayId = @attendanceDayId`,
      {
        ...AttendanceDay.params({ attendanceDayId: day.attendanceDayId }),
        actorId: AttendanceDay.param('modifiedBy', actorId),
      },
    );
  });

  const recomputed = await recomputeDay(day.attendanceDayId);

  await queryOne(
    `UPDATE ${RegularizationRequest.table}
        SET NewAttendanceStatusId = @newStatusId
      OUTPUT ${OUTPUT_REQUEST}
      WHERE RegularizationRequestId = @regularizationRequestId`,
    {
      ...RegularizationRequest.params({ regularizationRequestId }),
      newStatusId: RegularizationRequest.param(
        'newAttendanceStatusId',
        recomputed?.attendanceStatusId ?? ATTENDANCE_STATUS.REGULARIZED,
      ),
    },
  );

  return {
    request: await getRequest(regularizationRequestId),
    day: await dayDetail(request.employeeDetailId, request.attendanceDate),
  };
}

/**
 * Reject. Nothing is written to the attendance row - the day stays as it
 * was recorded, which is the point of a rejection.
 */
export async function reject(actorId, regularizationRequestId, { remarks = null } = {}) {
  const request = await getRequest(regularizationRequestId);

  if (request.status !== REGULARIZATION_STATUS.PENDING) {
    throw ApiError.conflict(MESSAGES.REGULARIZATION_NOT_PENDING, {
      code: ERROR_CODE.REGULARIZATION_NOT_PENDING,
      status: request.status,
    });
  }
  if (Number(request.employeeDetailId) === Number(actorId)) {
    throw ApiError.forbidden(MESSAGES.REGULARIZATION_SELF_APPROVAL, {
      code: ERROR_CODE.LEAVE_SELF_APPROVAL,
    });
  }

  const row = await queryOne(
    `UPDATE ${RegularizationRequest.table}
        SET Status          = @rejected,
            ApprovedBy      = @actorId,
            ApprovedAt      = SYSUTCDATETIME(),
            ApproverRemarks = @remarks,
            ModifiedBy      = @actorId,
            ModifiedAt      = SYSUTCDATETIME()
      OUTPUT ${OUTPUT_REQUEST}
      WHERE RegularizationRequestId = @regularizationRequestId AND Status = @pending`,
    {
      ...RegularizationRequest.params({ regularizationRequestId, approverRemarks: remarks }),
      rejected: RegularizationRequest.param('status', REGULARIZATION_STATUS.REJECTED),
      pending: RegularizationRequest.param('status', REGULARIZATION_STATUS.PENDING),
      remarks: RegularizationRequest.param('approverRemarks', remarks),
      actorId: RegularizationRequest.param('approvedBy', actorId),
    },
  );
  return shape(row);
}

/** The employee withdrawing their own request, before anybody acts. */
export async function cancel(actorId, employeeDetailId, regularizationRequestId) {
  const row = await queryOne(
    `UPDATE ${RegularizationRequest.table}
        SET Status = @cancelled, ModifiedBy = @actorId, ModifiedAt = SYSUTCDATETIME()
      OUTPUT ${OUTPUT_REQUEST}
      WHERE RegularizationRequestId = @regularizationRequestId
        AND EmployeeDetailId = @employeeDetailId
        AND Status = @pending AND DeletedAt IS NULL`,
    {
      ...RegularizationRequest.params({ regularizationRequestId, employeeDetailId }),
      cancelled: RegularizationRequest.param('status', REGULARIZATION_STATUS.CANCELLED),
      pending: RegularizationRequest.param('status', REGULARIZATION_STATUS.PENDING),
      actorId: RegularizationRequest.param('modifiedBy', actorId),
    },
  );
  if (!row) {
    throw ApiError.notFound(MESSAGES.REGULARIZATION_NOT_FOUND, {
      code: ERROR_CODE.REGULARIZATION_NOT_FOUND,
    });
  }
  return shape(row);
}

/**
 * Expire the requests whose window has closed. Run from the nightly job.
 *
 * A separate state from REJECTED on purpose: nobody turned these down,
 * they simply ran out of time, and a manager's rejection rate should not
 * be polluted by requests they never saw.
 */
export async function expireOverdue() {
  const rows = await query(
    `UPDATE ${RegularizationRequest.table}
        SET Status = @expired, ModifiedAt = SYSUTCDATETIME()
      OUTPUT inserted.RegularizationRequestId AS regularizationRequestId
      WHERE Status = @pending
        AND SubmissionDeadline IS NOT NULL
        AND SubmissionDeadline < SYSUTCDATETIME()
        AND DeletedAt IS NULL`,
    {
      expired: RegularizationRequest.param('status', REGULARIZATION_STATUS.EXPIRED),
      pending: RegularizationRequest.param('status', REGULARIZATION_STATUS.PENDING),
    },
  );
  return rows.length;
}

export { AttendanceStatus };
