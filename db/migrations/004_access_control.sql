/*
  Access control: roles, groups, per-user overrides and row-level scope.

  Nine tables answering one question on every request - "may this person do
  this, and to whose records?" Three sources stack to answer it: the roles a
  person holds, the groups they belong to, and per-user exceptions. A DENY
  exception removes a permission whatever granted it; otherwise the effective
  scope is the widest any source gave.

  Scope is materialised as a PERSISTED computed ScopeRank on every grant table,
  so "widest wins" is a plain MAX() in the resolver rather than a CASE repeated
  in the hot path - and so the OWN/TEAM/DEPARTMENT/ALL ordering cannot drift
  between the database and src/enums/permission.enum.js.

  Subjects are keyed on dbo.tblEmployeeDetails.EmployeeDetailId (BIGINT) - the
  person, not the credential. Permissions belong to an employee; the login is
  just one way that employee reaches the system, and dbo.EmployeeLogin carries
  a NOT NULL EmployeeDetailId so the token can hand the resolver that id
  directly.

  Row scope falls out of this for free: ManagerId and DepartmentId on the
  profile table are in the same id space as the subject, so a TEAM clause is a
  plain comparison with no translation step to get wrong.

  Soft delete everywhere, including the join tables: "who gave Bob HR Admin, and
  when" is worth keeping, and the DeletedAt predicate is free because every
  index below is filtered on it.

  Times are UTC (SYSUTCDATETIME()), as everywhere else in this schema.

  Note for hand-written queries: these tables carry filtered indexes AND
  PERSISTED computed columns, so SQL Server refuses INSERT/UPDATE/DELETE unless
  QUOTED_IDENTIFIER is ON. The driver and SSMS set it ON already; sqlcmd does
  not, so run sqlcmd with -I.
*/

IF OBJECT_ID('dbo.tblPermission', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblPermission (
        PermissionId    BIGINT          IDENTITY(1,1) NOT NULL,

        -- 'employees.view'. Lowercase, dotted, module first. Role, group and
        -- override rows point at the id; humans and the enum point at the
        -- code, so renaming one is a data migration, not an UPDATE.
        PermissionCode  NVARCHAR(100)   NOT NULL,
        -- The two halves of the code, stored so the admin screen can group 56
        -- permissions by module without parsing strings in SQL.
        Module          NVARCHAR(50)    NOT NULL,
        Action          NVARCHAR(50)    NOT NULL,
        Description     NVARCHAR(255)   NOT NULL,

        -- False for permissions that do not address anybody's rows: there is
        -- no "my role", so roles.create takes no scope.
        IsScoped        BIT             NOT NULL
            CONSTRAINT DF_tblPermission_IsScoped DEFAULT 0,
        -- What the admin UI preselects when a scoped permission is first
        -- ticked. NULL when IsScoped = 0.
        DefaultScope    NVARCHAR(20)    NULL,

        CreatedBy       BIGINT             NULL,
        ModifiedBy      BIGINT             NULL,
        CreatedAt       DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblPermission_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt      DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblPermission_ModifiedAt DEFAULT SYSUTCDATETIME(),
        -- Retired, not deleted: grants still reference it.
        DeletedAt       DATETIME2(3)    NULL,

        CONSTRAINT PK_tblPermission PRIMARY KEY CLUSTERED (PermissionId),
        CONSTRAINT FK_tblPermission_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblPermission_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        -- The code is the join between the enum and the table. A comma would
        -- break the STRING_SPLIT retirement sweep in the seed; an uppercase
        -- letter would compare equal here (the collation is case-insensitive)
        -- but not in the JS Map the resolver builds.
        CONSTRAINT CK_tblPermission_CodeShape CHECK (
            PermissionCode LIKE '%.%'
            AND PermissionCode NOT LIKE '%,%'
            AND PermissionCode COLLATE Latin1_General_BIN2
                = LOWER(PermissionCode) COLLATE Latin1_General_BIN2
        ),
        CONSTRAINT CK_tblPermission_DefaultScope CHECK (
            (IsScoped = 1 AND DefaultScope IN ('OWN','TEAM','DEPARTMENT','ALL'))
         OR (IsScoped = 0 AND DefaultScope IS NULL)
        )
    );

    /*
      DELIBERATELY NOT FILTERED, unlike every other unique index in this schema.

      Retiring a code and later re-adding it to the enum must resurrect the SAME
      PermissionId, because role and group grants still point at it. A filtered
      index would let the seed insert a second row with the same code and
      silently orphan every existing grant - the kind of bug that shows up as
      "HR Admin lost payroll access" months later.
    */
    CREATE UNIQUE INDEX UQ_tblPermission_PermissionCode
        ON dbo.tblPermission (PermissionCode);

    -- The catalog screen lists by module; the resolver joins by id.
    CREATE INDEX IX_tblPermission_Module
        ON dbo.tblPermission (Module, Action) WHERE DeletedAt IS NULL;
END;

IF OBJECT_ID('dbo.tblRole', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblRole (
        RoleId      BIGINT          IDENTITY(1,1) NOT NULL,

        RoleCode    NVARCHAR(50)    NOT NULL,   -- SUPER_ADMIN, HR_ADMIN, ...
        RoleName    NVARCHAR(100)   NOT NULL,
        Description NVARCHAR(255)   NULL,

        -- The five master roles. Protects the code from a rename and the row
        -- from a delete. It deliberately does NOT protect the role's
        -- permissions: editing those is the whole point of the feature.
        IsSystem    BIT             NOT NULL
            CONSTRAINT DF_tblRole_IsSystem DEFAULT 0,
        IsActive    BIT             NOT NULL
            CONSTRAINT DF_tblRole_IsActive DEFAULT 1,

        CreatedBy   BIGINT             NULL,
        ModifiedBy  BIGINT             NULL,
        CreatedAt   DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblRole_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt  DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblRole_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt   DATETIME2(3)    NULL,

        CONSTRAINT PK_tblRole PRIMARY KEY CLUSTERED (RoleId),
        CONSTRAINT FK_tblRole_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblRole_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        -- Delete protection, declared rather than left to a service-layer `if`
        -- that one future endpoint will forget.
        CONSTRAINT CK_tblRole_SystemNotDeleted CHECK (IsSystem = 0 OR DeletedAt IS NULL)
    );

    -- Filtered here, unlike tblPermission: deleting "Finance Lead" should free
    -- the name for a new role. Nothing resurrects roles automatically.
    CREATE UNIQUE INDEX UQ_tblRole_RoleCode
        ON dbo.tblRole (RoleCode) WHERE DeletedAt IS NULL;
    CREATE UNIQUE INDEX UQ_tblRole_RoleName
        ON dbo.tblRole (RoleName) WHERE DeletedAt IS NULL;
END;

IF OBJECT_ID('dbo.tblGroup', 'U') IS NULL
BEGIN
    /*
      A bundle of permissions several people share - "Payroll Reviewers".

      Groups carry permissions, never roles. A group holding roles would create
      a second inheritance axis and the diamond problem that comes with it, for
      no capability a flat bundle does not already give.

      No IsSystem column: every group is user data and all of them are
      deletable.
    */
    CREATE TABLE dbo.tblGroup (
        GroupId     BIGINT          IDENTITY(1,1) NOT NULL,

        GroupCode   NVARCHAR(50)    NOT NULL,
        GroupName   NVARCHAR(100)   NOT NULL,
        Description NVARCHAR(255)   NULL,

        IsActive    BIT             NOT NULL
            CONSTRAINT DF_tblGroup_IsActive DEFAULT 1,

        CreatedBy   BIGINT             NULL,
        ModifiedBy  BIGINT             NULL,
        CreatedAt   DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblGroup_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt  DATETIME2(3)    NOT NULL
            CONSTRAINT DF_tblGroup_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt   DATETIME2(3)    NULL,

        CONSTRAINT PK_tblGroup PRIMARY KEY CLUSTERED (GroupId),
        CONSTRAINT FK_tblGroup_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblGroup_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblGroup_GroupCode
        ON dbo.tblGroup (GroupCode) WHERE DeletedAt IS NULL;
    CREATE UNIQUE INDEX UQ_tblGroup_GroupName
        ON dbo.tblGroup (GroupName) WHERE DeletedAt IS NULL;
END;

IF OBJECT_ID('dbo.tblRolePermission', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblRolePermission (
        RolePermissionId BIGINT       IDENTITY(1,1) NOT NULL,
        RoleId           BIGINT       NOT NULL,
        PermissionId     BIGINT       NOT NULL,

        -- How far this grant reaches. Manager holds employees.view at TEAM,
        -- HR Admin holds the same permission at ALL.
        Scope            NVARCHAR(20) NOT NULL
            CONSTRAINT DF_tblRolePermission_Scope DEFAULT 'OWN',
        -- Derived, never written - SQL Server rejects it in an INSERT column
        -- list. Mirrors PERMISSION_SCOPE_RANK in src/enums/permission.enum.js,
        -- and exists so the resolver says MAX(ScopeRank) and nothing more.
        ScopeRank AS (CASE Scope WHEN 'OWN' THEN 1 WHEN 'TEAM' THEN 2
                                 WHEN 'DEPARTMENT' THEN 3 WHEN 'ALL' THEN 4 END) PERSISTED,

        CreatedBy  BIGINT          NULL,
        ModifiedBy BIGINT          NULL,
        CreatedAt  DATETIME2(3) NOT NULL
            CONSTRAINT DF_tblRolePermission_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt DATETIME2(3) NOT NULL
            CONSTRAINT DF_tblRolePermission_ModifiedAt DEFAULT SYSUTCDATETIME(),
        -- Revoking stamps this. The row stays, so "who took employees.delete
        -- off HR Executive in March" is answerable.
        DeletedAt  DATETIME2(3) NULL,

        CONSTRAINT PK_tblRolePermission PRIMARY KEY CLUSTERED (RolePermissionId),
        CONSTRAINT FK_tblRolePermission_Role
            FOREIGN KEY (RoleId)       REFERENCES dbo.tblRole (RoleId),
        CONSTRAINT FK_tblRolePermission_Permission
            FOREIGN KEY (PermissionId) REFERENCES dbo.tblPermission (PermissionId),
        CONSTRAINT FK_tblRolePermission_CreatedBy
            FOREIGN KEY (CreatedBy)    REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblRolePermission_ModifiedBy
            FOREIGN KEY (ModifiedBy)   REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT CK_tblRolePermission_Scope CHECK (Scope IN ('OWN','TEAM','DEPARTMENT','ALL'))
    );

    -- One live grant per (role, permission). Re-granting after a revoke inserts
    -- a new row rather than resurrecting, so the history reads as a sequence.
    CREATE UNIQUE INDEX UQ_tblRolePermission_RolePermission
        ON dbo.tblRolePermission (RoleId, PermissionId) WHERE DeletedAt IS NULL;

    -- Covers the resolver's seek, so the hot query never touches the base table.
    CREATE INDEX IX_tblRolePermission_Role
        ON dbo.tblRolePermission (RoleId) INCLUDE (PermissionId, ScopeRank)
        WHERE DeletedAt IS NULL;
END;

IF OBJECT_ID('dbo.tblGroupPermission', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblGroupPermission (
        GroupPermissionId BIGINT       IDENTITY(1,1) NOT NULL,
        GroupId           BIGINT       NOT NULL,
        PermissionId      BIGINT       NOT NULL,

        Scope             NVARCHAR(20) NOT NULL
            CONSTRAINT DF_tblGroupPermission_Scope DEFAULT 'OWN',
        ScopeRank AS (CASE Scope WHEN 'OWN' THEN 1 WHEN 'TEAM' THEN 2
                                 WHEN 'DEPARTMENT' THEN 3 WHEN 'ALL' THEN 4 END) PERSISTED,

        CreatedBy  BIGINT          NULL,
        ModifiedBy BIGINT          NULL,
        CreatedAt  DATETIME2(3) NOT NULL
            CONSTRAINT DF_tblGroupPermission_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt DATETIME2(3) NOT NULL
            CONSTRAINT DF_tblGroupPermission_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt  DATETIME2(3) NULL,

        CONSTRAINT PK_tblGroupPermission PRIMARY KEY CLUSTERED (GroupPermissionId),
        CONSTRAINT FK_tblGroupPermission_Group
            FOREIGN KEY (GroupId)      REFERENCES dbo.tblGroup (GroupId),
        CONSTRAINT FK_tblGroupPermission_Permission
            FOREIGN KEY (PermissionId) REFERENCES dbo.tblPermission (PermissionId),
        CONSTRAINT FK_tblGroupPermission_CreatedBy
            FOREIGN KEY (CreatedBy)    REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblGroupPermission_ModifiedBy
            FOREIGN KEY (ModifiedBy)   REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT CK_tblGroupPermission_Scope CHECK (Scope IN ('OWN','TEAM','DEPARTMENT','ALL'))
    );

    CREATE UNIQUE INDEX UQ_tblGroupPermission_GroupPermission
        ON dbo.tblGroupPermission (GroupId, PermissionId) WHERE DeletedAt IS NULL;

    CREATE INDEX IX_tblGroupPermission_Group
        ON dbo.tblGroupPermission (GroupId) INCLUDE (PermissionId, ScopeRank)
        WHERE DeletedAt IS NULL;
END;

IF OBJECT_ID('dbo.tblEmployeeRole', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblEmployeeRole (
        EmployeeRoleId BIGINT       IDENTITY(1,1) NOT NULL,
        -- The person who holds the role, never the credential. BIGINT,
        -- matching dbo.tblEmployeeDetails.EmployeeDetailId exactly.
        EmployeeDetailId BIGINT     NOT NULL,
        RoleId           BIGINT     NOT NULL,

        CreatedBy  BIGINT          NULL,
        ModifiedBy BIGINT          NULL,
        CreatedAt  DATETIME2(3) NOT NULL
            CONSTRAINT DF_tblEmployeeRole_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt DATETIME2(3) NOT NULL
            CONSTRAINT DF_tblEmployeeRole_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt  DATETIME2(3) NULL,

        CONSTRAINT PK_tblEmployeeRole PRIMARY KEY CLUSTERED (EmployeeRoleId),
        CONSTRAINT FK_tblEmployeeRole_Employee
            FOREIGN KEY (EmployeeDetailId) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeRole_Role
            FOREIGN KEY (RoleId)     REFERENCES dbo.tblRole (RoleId),
        CONSTRAINT FK_tblEmployeeRole_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeRole_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblEmployeeRole_EmployeeRole
        ON dbo.tblEmployeeRole (EmployeeDetailId, RoleId) WHERE DeletedAt IS NULL;
    CREATE INDEX IX_tblEmployeeRole_Employee
        ON dbo.tblEmployeeRole (EmployeeDetailId) INCLUDE (RoleId) WHERE DeletedAt IS NULL;
    -- "Who holds SUPER_ADMIN" - the admin screen, and the guard that refuses
    -- to unassign the last one.
    CREATE INDEX IX_tblEmployeeRole_Role
        ON dbo.tblEmployeeRole (RoleId) INCLUDE (EmployeeDetailId) WHERE DeletedAt IS NULL;
END;

IF OBJECT_ID('dbo.tblEmployeeGroup', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblEmployeeGroup (
        EmployeeGroupId BIGINT       IDENTITY(1,1) NOT NULL,
        EmployeeDetailId      BIGINT          NOT NULL,
        GroupId         BIGINT       NOT NULL,

        CreatedBy  BIGINT          NULL,
        ModifiedBy BIGINT          NULL,
        CreatedAt  DATETIME2(3) NOT NULL
            CONSTRAINT DF_tblEmployeeGroup_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt DATETIME2(3) NOT NULL
            CONSTRAINT DF_tblEmployeeGroup_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt  DATETIME2(3) NULL,

        CONSTRAINT PK_tblEmployeeGroup PRIMARY KEY CLUSTERED (EmployeeGroupId),
        CONSTRAINT FK_tblEmployeeGroup_Employee
            FOREIGN KEY (EmployeeDetailId) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeGroup_Group
            FOREIGN KEY (GroupId)    REFERENCES dbo.tblGroup (GroupId),
        CONSTRAINT FK_tblEmployeeGroup_CreatedBy
            FOREIGN KEY (CreatedBy)  REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeeGroup_ModifiedBy
            FOREIGN KEY (ModifiedBy) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId)
    );

    CREATE UNIQUE INDEX UQ_tblEmployeeGroup_EmployeeGroup
        ON dbo.tblEmployeeGroup (EmployeeDetailId, GroupId) WHERE DeletedAt IS NULL;
    CREATE INDEX IX_tblEmployeeGroup_Employee
        ON dbo.tblEmployeeGroup (EmployeeDetailId) INCLUDE (GroupId) WHERE DeletedAt IS NULL;
    CREATE INDEX IX_tblEmployeeGroup_Group
        ON dbo.tblEmployeeGroup (GroupId) INCLUDE (EmployeeDetailId) WHERE DeletedAt IS NULL;
END;

IF OBJECT_ID('dbo.tblEmployeePermission', 'U') IS NULL
BEGIN
    /*
      The per-user exception: give one person something their role does not
      carry, or take something away without changing their role.
    */
    CREATE TABLE dbo.tblEmployeePermission (
        EmployeePermissionId BIGINT       IDENTITY(1,1) NOT NULL,
        EmployeeDetailId           BIGINT          NOT NULL,
        PermissionId         BIGINT       NOT NULL,

        Effect               NVARCHAR(10) NOT NULL,   -- 'GRANT' | 'DENY'

        -- NULL for a DENY, and the CHECK below makes that mandatory rather
        -- than a convention. A DENY is absolute: it removes the permission
        -- whatever a role or group says, so a scope on it would be a lie.
        -- Narrowing ("Bob's role gives TEAM, cap Bob at OWN") is therefore not
        -- representable - the fix for that case is to not give Bob the role.
        Scope                NVARCHAR(20) NULL,
        ScopeRank AS (CASE Scope WHEN 'OWN' THEN 1 WHEN 'TEAM' THEN 2
                                 WHEN 'DEPARTMENT' THEN 3 WHEN 'ALL' THEN 4 END) PERSISTED,

        -- Why this exception exists. Required by the API, because an override
        -- nobody can explain is how an access table becomes unauditable.
        Reason               NVARCHAR(255) NULL,
        -- Optional expiry for a temporary grant. NULL means permanent.
        ExpiresAt            DATETIME2(3)  NULL,

        CreatedBy  BIGINT          NULL,
        ModifiedBy BIGINT          NULL,
        CreatedAt  DATETIME2(3) NOT NULL
            CONSTRAINT DF_tblEmployeePermission_CreatedAt  DEFAULT SYSUTCDATETIME(),
        ModifiedAt DATETIME2(3) NOT NULL
            CONSTRAINT DF_tblEmployeePermission_ModifiedAt DEFAULT SYSUTCDATETIME(),
        DeletedAt  DATETIME2(3) NULL,

        CONSTRAINT PK_tblEmployeePermission PRIMARY KEY CLUSTERED (EmployeePermissionId),
        CONSTRAINT FK_tblEmployeePermission_Employee
            FOREIGN KEY (EmployeeDetailId) REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeePermission_Permission
            FOREIGN KEY (PermissionId) REFERENCES dbo.tblPermission (PermissionId),
        CONSTRAINT FK_tblEmployeePermission_CreatedBy
            FOREIGN KEY (CreatedBy)    REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),
        CONSTRAINT FK_tblEmployeePermission_ModifiedBy
            FOREIGN KEY (ModifiedBy)   REFERENCES dbo.tblEmployeeDetails (EmployeeDetailId),

        CONSTRAINT CK_tblEmployeePermission_Effect CHECK (Effect IN ('GRANT','DENY')),
        CONSTRAINT CK_tblEmployeePermission_Scope CHECK (
            (Effect = 'GRANT' AND Scope IN ('OWN','TEAM','DEPARTMENT','ALL'))
         OR (Effect = 'DENY'  AND Scope IS NULL)
        )
    );

    -- One live override per (employee, permission). This is what makes a
    -- simultaneous GRANT and DENY for the same pair UNREPRESENTABLE, rather
    -- than a conflict the resolver has to arbitrate at runtime. Precedence
    -- then only ever fires across sources, never within one.
    CREATE UNIQUE INDEX UQ_tblEmployeePermission_EmployeePermission
        ON dbo.tblEmployeePermission (EmployeeDetailId, PermissionId) WHERE DeletedAt IS NULL;

    CREATE INDEX IX_tblEmployeePermission_Employee
        ON dbo.tblEmployeePermission (EmployeeDetailId)
        INCLUDE (PermissionId, Effect, ScopeRank, ExpiresAt)
        WHERE DeletedAt IS NULL;
END;

IF OBJECT_ID('dbo.tblAccessControlStamp', 'U') IS NULL
BEGIN
    /*
      One row of bookkeeping: the signal that tells every process its cached
      permission sets are stale.

      Each admin write bumps Version inside its own transaction. Every instance
      polls this row on a short interval; when the number moves it drops its
      cache. Polling rather than reading per request is the point - a
      per-request read would be the round trip the cache exists to remove.

      No soft delete and no audit columns: this is the moral equivalent of
      dbo._Migrations. Unlike that table it does get a model, because the
      application reads it.
    */
    CREATE TABLE dbo.tblAccessControlStamp (
        StampId    BIGINT        IDENTITY(1,1) NOT NULL,
        StampName  NVARCHAR(50)  NOT NULL,
        Version    BIGINT        NOT NULL
            CONSTRAINT DF_tblAccessControlStamp_Version DEFAULT 1,
        ModifiedAt DATETIME2(3)  NOT NULL
            CONSTRAINT DF_tblAccessControlStamp_ModifiedAt DEFAULT SYSUTCDATETIME(),

        CONSTRAINT PK_tblAccessControlStamp PRIMARY KEY CLUSTERED (StampId)
    );

    CREATE UNIQUE INDEX UQ_tblAccessControlStamp_StampName
        ON dbo.tblAccessControlStamp (StampName);
END;
GO

/*
  Seeded by the migration rather than the seed script, so the poller finds the
  row on a fresh database even before anyone has run db:seed:permissions.
  Needs its own batch: the INSERT cannot compile against a table created in the
  same one.
*/
INSERT INTO dbo.tblAccessControlStamp (StampName)
SELECT N'global'
 WHERE NOT EXISTS (SELECT 1 FROM dbo.tblAccessControlStamp WHERE StampName = N'global');
