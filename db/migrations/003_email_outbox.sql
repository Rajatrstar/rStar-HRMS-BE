/*
  Outbound email queue.

  Nothing in the request path talks to SMTP. A caller renders the email and
  writes one row here; a background worker claims rows, sends them and retries
  on failure. That keeps login fast and means an SMTP outage delays mail
  instead of breaking the API.

  Subject and body are stored already rendered, so the row is also the audit
  record of exactly what was sent - editing a template later cannot rewrite
  history, which matters the first time somebody says they never got their
  offer letter.

  Times are UTC (SYSUTCDATETIME()), as everywhere else in this schema.

  Note for hand-written queries: this table carries filtered indexes, so SQL
  Server refuses INSERT/UPDATE/DELETE on it unless QUOTED_IDENTIFIER is ON.
  The driver and SSMS set it ON already; sqlcmd does not, so run sqlcmd with
  -I when poking at this table by hand.
*/

IF OBJECT_ID('dbo.EmailOutbox', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.EmailOutbox (
        EmailId         INT             IDENTITY(1,1) NOT NULL,

        -- Matches a value of EMAIL_TEMPLATE in src/enums/email-template.enum.js.
        -- Kept for reporting ("how many OTP mails failed yesterday"), not used
        -- to send: the rendered copy below is what goes out.
        TemplateCode    NVARCHAR(64)    NOT NULL,

        ToAddress       NVARCHAR(512)   NOT NULL,
        CcAddress       NVARCHAR(512)   NULL,
        Subject         NVARCHAR(512)   NOT NULL,
        HtmlBody        NVARCHAR(MAX)   NOT NULL,
        TextBody        NVARCHAR(MAX)   NULL,

        -- Pending  : waiting for NextAttemptAt
        -- Sending  : claimed by a worker right now
        -- Sent     : accepted by the mail server
        -- Failed   : gave up after MaxAttempts
        Status          NVARCHAR(16)    NOT NULL
            CONSTRAINT DF_EmailOutbox_Status DEFAULT 'Pending',

        AttemptCount    INT             NOT NULL
            CONSTRAINT DF_EmailOutbox_AttemptCount DEFAULT 0,
        MaxAttempts     INT             NOT NULL
            CONSTRAINT DF_EmailOutbox_MaxAttempts DEFAULT 5,

        -- Drives the retry backoff. A new row is due immediately.
        NextAttemptAt   DATETIME2(3)    NOT NULL
            CONSTRAINT DF_EmailOutbox_NextAttemptAt DEFAULT SYSUTCDATETIME(),

        LastError       NVARCHAR(2000)  NULL,
        SentAt          DATETIME2(3)    NULL,

        CreatedAt       DATETIME2(3)    NOT NULL
            CONSTRAINT DF_EmailOutbox_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt      DATETIME2(3)    NOT NULL
            CONSTRAINT DF_EmailOutbox_ModifiedAt DEFAULT SYSUTCDATETIME(),

        CONSTRAINT PK_EmailOutbox PRIMARY KEY CLUSTERED (EmailId),
        CONSTRAINT CK_EmailOutbox_Status CHECK (Status IN ('Pending', 'Sending', 'Sent', 'Failed'))
    );

    /*
      The worker's claim query reads exactly this slice: rows that are Pending
      and due. A filtered index keeps it off the Sent rows, which is almost the
      whole table once the system has been running a while.
    */
    CREATE INDEX IX_EmailOutbox_Pending
        ON dbo.EmailOutbox (NextAttemptAt)
        WHERE Status = 'Pending';

    /*
      Used by the sweep that recovers rows left in Sending by a process that
      died mid-send. Without it that scan would grow with the table.
    */
    CREATE INDEX IX_EmailOutbox_Sending
        ON dbo.EmailOutbox (ModifiedAt)
        WHERE Status = 'Sending';
END;
