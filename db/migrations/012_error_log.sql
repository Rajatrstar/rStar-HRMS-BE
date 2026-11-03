/*
  Error log - every failure the server did not mean to have.

  Until now a 500 went to the console and nowhere else: gone at the next
  restart, invisible on a machine nobody is watching, and impossible to match
  to the user who reported it. This table keeps them.

  WHAT IS WRITTEN HERE (src/services/error-log.service.js is the only writer):

      API      - a request that answered 5xx. 4xx is the client's mistake
                 (bad field, no token, no right, duplicate) and is ordinary
                 traffic; logging it would also let anyone fill the table.
      JOB      - a background failure: the email outbox, the log purge.
      PROCESS  - an uncaught exception or unhandled rejection, just before
                 the process exits.
      STARTUP  - the server failed to boot (when the database is reachable).

  The RequestId is also returned to the client - X-Request-Id on every
  response, details.requestId on a 5xx - so "it said something went wrong"
  becomes one row instead of a search.

  DELIBERATELY UNLIKE THE OTHER TABLES:

    - No DeletedAt, no CreatedBy/ModifiedBy. It is append-only; rows leave
      only through the retention purge (ERROR_LOG_RETENTION_DAYS).
    - No foreign keys. A log write must never fail because the employee it
      names was deleted, and a row must outlive that employee.
    - Nothing secret. Passwords, OTPs, tokens, cookies and PAN/Aadhaar numbers
      are masked by key name before the row is built, and file bytes are
      never part of a request body here.
*/

IF OBJECT_ID('dbo.tblErrorLog', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblErrorLog (
        ErrorLogId       BIGINT            IDENTITY(1,1) NOT NULL,

        -- Same value as the X-Request-Id header. NULL outside a request.
        RequestId        UNIQUEIDENTIFIER  NULL,

        OccurredAt       DATETIME2(3)      NOT NULL
            CONSTRAINT DF_tblErrorLog_OccurredAt DEFAULT SYSUTCDATETIME(),

        Source           NVARCHAR(20)      NOT NULL,
        Severity         NVARCHAR(10)      NOT NULL,

        -- The request, when there was one.
        HttpMethod       NVARCHAR(10)      NULL,
        -- The route as declared, e.g. /api/v1/employees/:employeeDetailId, so
        -- the same failure groups across ids. NULL when no route matched yet.
        RoutePattern     NVARCHAR(300)     NULL,
        -- The path actually called, query values masked.
        Url              NVARCHAR(1000)    NULL,
        StatusCode       SMALLINT          NULL,
        -- details.code, when the error carried one.
        ErrorCode        NVARCHAR(100)     NULL,

        -- What went wrong, as the server saw it - never shown to the client.
        ErrorName        NVARCHAR(200)     NULL,
        Message          NVARCHAR(2000)    NULL,
        StackTrace       NVARCHAR(MAX)     NULL,
        -- error.number from the SQL driver: 2627 duplicate, 547 FK, 1205 deadlock...
        SqlErrorNumber   INT               NULL,

        -- JSON, secrets masked, cut at 8 KB.
        RequestBody      NVARCHAR(MAX)     NULL,

        -- Who was calling. Audit only, so no FK - see above.
        EmployeeDetailId BIGINT            NULL,
        IpAddress        NVARCHAR(45)      NULL,
        UserAgent        NVARCHAR(500)     NULL,
        DurationMs       INT               NULL,

        -- Which instance, which environment.
        ServerName       NVARCHAR(100)     NULL,
        Environment      NVARCHAR(20)      NULL,

        -- SHA-256 of name + route + first stack frame: one bug, one value,
        -- however many times it fires.
        Fingerprint      CHAR(64)          NULL,

        -- Triage. Set by hand (or a future admin screen) once a cause is fixed.
        IsResolved       BIT               NOT NULL
            CONSTRAINT DF_tblErrorLog_IsResolved DEFAULT 0,
        ResolvedBy       BIGINT            NULL,
        ResolvedAt       DATETIME2(3)      NULL,
        ResolutionNote   NVARCHAR(1000)    NULL,

        CONSTRAINT PK_tblErrorLog PRIMARY KEY CLUSTERED (ErrorLogId),

        CONSTRAINT CK_tblErrorLog_Source
            CHECK (Source IN ('API', 'JOB', 'PROCESS', 'STARTUP')),
        CONSTRAINT CK_tblErrorLog_Severity
            CHECK (Severity IN ('ERROR', 'FATAL'))
    );

    -- Newest first, and the retention purge's range.
    CREATE INDEX IX_tblErrorLog_OccurredAt
        ON dbo.tblErrorLog (OccurredAt DESC);

    -- "The user's screen said ref 9f1c..." - a single seek.
    CREATE INDEX IX_tblErrorLog_RequestId
        ON dbo.tblErrorLog (RequestId)
        WHERE RequestId IS NOT NULL;

    -- How often does this bug fire, and since when.
    CREATE INDEX IX_tblErrorLog_Fingerprint
        ON dbo.tblErrorLog (Fingerprint, OccurredAt DESC);

    -- The open-issues list.
    CREATE INDEX IX_tblErrorLog_Open
        ON dbo.tblErrorLog (IsResolved, OccurredAt DESC);
END;
