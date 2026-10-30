/*
  Revoked sessions - what makes logout mean something.

  A JWT is self-contained: once signed, it is valid until it expires and the
  server has no say in it. "Log out" that only deletes the token in the browser
  is therefore a UI gesture, not a security control - anyone holding a copy of
  the access token keeps the access, and the refresh token keeps minting new
  ones for the rest of its five days.

  So both tokens now carry the same SessionId, and logout writes that id here.
  One row kills the pair, because the check is on the id they share rather than
  on either token's own bytes:

      login / verify-otp  ->  SessionId S, access(S) + refresh(S)
      refresh             ->  SessionId S, a NEW access(S) + refresh(S)
      logout              ->  INSERT S   ->  every token carrying S is dead

  Keeping the id across a refresh is the point. Minting a fresh SessionId on
  each refresh would leave the previous refresh token outside the revocation
  and quietly undo the logout.

  Why a denylist of revoked sessions, and not a table of live ones:

    - it stays small. One row per logout, not one per login, and every row is
      deletable the moment the tokens it names could no longer be accepted.
    - the common path writes nothing. Issuing tokens stays a signature, with no
      INSERT on the login hot path.

  The cost is a lookup on each authenticated request. It is a single-row seek
  on a unique index over a table that is usually smaller than a page, and it
  is the price of logout being real. src/middlewares/auth.middleware.js is the
  only caller.
*/

IF OBJECT_ID('dbo.tblRevokedSession', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblRevokedSession (
        RevokedSessionId BIGINT          IDENTITY(1,1) NOT NULL,

        -- The `sid` claim carried by both tokens of one login.
        SessionId        UNIQUEIDENTIFIER NOT NULL,

        -- Who logged out. Audit only: the check is by SessionId alone, and a
        -- revoked session must stay revoked even if the employee row is later
        -- soft-deleted.
        EmployeeDetailId BIGINT          NOT NULL,

        /*
          When the last token naming this session would have expired anyway.
          After this moment the row proves nothing - the signature check
          rejects the token without help - so it exists only to be purged.

          Written from JWT_REFRESH_EXPIRES_IN at revocation time, because the
          refresh token always outlives the access token.
        */
        ExpiresAt        DATETIME2(3)    NOT NULL,

        RevokedAt        DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblRevokedSession_RevokedAt DEFAULT SYSUTCDATETIME(),

        CONSTRAINT PK_tblRevokedSession PRIMARY KEY CLUSTERED (RevokedSessionId),

        CONSTRAINT FK_tblRevokedSession_Employee
            FOREIGN KEY (EmployeeDetailId) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    /*
      The index every authenticated request rides. UNIQUE because logging out
      twice with the same token pair is an ordinary thing for a client to do -
      a retry, two tabs - and the second attempt should find the row already
      there rather than add another.
    */
    CREATE UNIQUE INDEX UQ_tblRevokedSession_SessionId
        ON dbo.tblRevokedSession (SessionId);

    -- The purge's whole query: rows whose tokens are dead on their own.
    CREATE INDEX IX_tblRevokedSession_ExpiresAt
        ON dbo.tblRevokedSession (ExpiresAt);
END;
