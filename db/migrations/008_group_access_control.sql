/*
  Group-based access control, replacing the role/permission/scope model from
  004 outright.

  WHAT CHANGES, and why it is a replacement rather than an addition.

  004 modelled access as a catalog of ~64 permission codes granted through
  three independent channels - roles, groups and per-user GRANT/DENY rows -
  each carrying a row SCOPE (OWN < TEAM < DEPARTMENT < ALL) that the widest
  grant won. That is more expressive than this organisation needs, and the
  expressiveness is the problem: "why can this person see that record" had
  three places to look and an aggregate to reason about.

  This is the model the EHMS portal has run on for years, and the one the
  administrators here already know how to operate:

      a GROUP holds rights on a MODULE, and an employee belongs to a GROUP.

  Nothing else. One place to look, one screen to change it on.

  Rights are the same six verbs that application uses, because they are the
  six a screen actually offers: View, Add, Edit, Delete, Print, Mail. Print
  and Mail are separate on purpose - "may read this" and "may walk out with a
  PDF of it" or "may email it to an outsider" are different decisions, and an
  HRMS holds the kind of data where that distinction earns its place.

  WHAT IS DELIBERATELY LOST. Row scope. Under 004 an employee could hold
  "employees.view" limited to their own team; here, a group either holds View
  on Employees or it does not, and holding it means seeing every employee.
  That is how the .NET application behaves and it is what was asked for. If
  "own team only" is wanted later it belongs as a column on tblAccessRight
  (a DataScope per right), not as a return to three channels - and the
  resolver is written so that addition touches one query.

  Module ids are FIXED, not IDENTITY. Code refers to them through MODULE in
  src/enums/module.enum.js, so the number is part of the contract: an id that
  shifted between environments would silently move everyone's rights onto a
  different screen. Same reasoning as clsEnum.Module in the .NET portal.
*/

-- ---------------------------------------------------------------------------
-- 1. Remove the 004 model.
--
-- Children before parents - a FOREIGN KEY will not let its target go first.
-- dbo.tblAccessControlStamp SURVIVES: it is cache bookkeeping, not part of
-- the permission model, and the new resolver uses it for exactly what the old
-- one did - telling other instances that a grant changed.
-- ---------------------------------------------------------------------------
IF OBJECT_ID('dbo.tblRolePermission', 'U')     IS NOT NULL DROP TABLE dbo.tblRolePermission;
IF OBJECT_ID('dbo.tblGroupPermission', 'U')    IS NOT NULL DROP TABLE dbo.tblGroupPermission;
IF OBJECT_ID('dbo.tblEmployeePermission', 'U') IS NOT NULL DROP TABLE dbo.tblEmployeePermission;
IF OBJECT_ID('dbo.tblEmployeeRole', 'U')       IS NOT NULL DROP TABLE dbo.tblEmployeeRole;
IF OBJECT_ID('dbo.tblEmployeeGroup', 'U')      IS NOT NULL DROP TABLE dbo.tblEmployeeGroup;
GO

IF OBJECT_ID('dbo.tblPermission', 'U') IS NOT NULL DROP TABLE dbo.tblPermission;
IF OBJECT_ID('dbo.tblRole', 'U')       IS NOT NULL DROP TABLE dbo.tblRole;
IF OBJECT_ID('dbo.tblGroup', 'U')      IS NOT NULL DROP TABLE dbo.tblGroup;
GO

-- ---------------------------------------------------------------------------
-- 2. dbo.tblModule - the catalog of things a group can hold rights on.
--
-- One row per SCREEN the frontend can navigate to, which is what makes the
-- menu and the page-rights lookup fall out of the same table instead of
-- needing a second one to keep in step with it.
-- ---------------------------------------------------------------------------
IF OBJECT_ID('dbo.tblModule', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblModule (
        -- NOT an identity. Seeded from MODULE in src/enums/module.enum.js.
        ModuleId        INT            NOT NULL CONSTRAINT PK_tblModule PRIMARY KEY,

        -- What code says: MODULE.EMPLOYEES = 'EMPLOYEES'. Stable, uppercase.
        ModuleCode      NVARCHAR(60)   NOT NULL,
        -- What the administrator reads on the group screen.
        ModuleName      NVARCHAR(100)  NOT NULL,
        Description     NVARCHAR(255)      NULL,

        -- Menu shape. A parent with no RoutePath is a heading that opens a
        -- submenu; a row with a RoutePath is a page you can land on.
        ParentModuleId  INT                NULL,
        RoutePath       NVARCHAR(150)      NULL,
        Icon            NVARCHAR(60)       NULL,
        SortOrder       INT            NOT NULL CONSTRAINT DF_tblModule_SortOrder DEFAULT (0),

        -- A module can be real but not a menu entry - a modal, a tab inside
        -- another page, or a capability with no screen of its own.
        ShowInMenu      BIT            NOT NULL CONSTRAINT DF_tblModule_ShowInMenu DEFAULT (1),
        IsActive        BIT            NOT NULL CONSTRAINT DF_tblModule_IsActive DEFAULT (1),

        CreatedBy       BIGINT             NULL,
        ModifiedBy      BIGINT             NULL,
        CreatedAt       DATETIME2(3)   NOT NULL CONSTRAINT DF_tblModule_CreatedAt DEFAULT SYSUTCDATETIME(),
        ModifiedAt      DATETIME2(3)   NOT NULL CONSTRAINT DF_tblModule_ModifiedAt DEFAULT SYSUTCDATETIME(),

        CONSTRAINT FK_tblModule_Parent FOREIGN KEY (ParentModuleId)
            REFERENCES dbo.tblModule (ModuleId),
        -- A module cannot be its own parent. Deeper cycles are not reachable:
        -- the seed is two levels and the module API does not reparent.
        CONSTRAINT CK_tblModule_NotOwnParent CHECK (ParentModuleId <> ModuleId)
    );

    CREATE UNIQUE INDEX UQ_tblModule_ModuleCode ON dbo.tblModule (ModuleCode);
    CREATE INDEX IX_tblModule_Parent ON dbo.tblModule (ParentModuleId, SortOrder);
END
GO

-- ---------------------------------------------------------------------------
-- 3. dbo.tblGroup - what an administrator creates and names.
-- ---------------------------------------------------------------------------
IF OBJECT_ID('dbo.tblGroup', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblGroup (
        GroupId     INT            NOT NULL IDENTITY(1, 1) CONSTRAINT PK_tblGroup PRIMARY KEY,

        GroupName   NVARCHAR(100)  NOT NULL,
        Description NVARCHAR(255)      NULL,

        -- Administrator is seeded with every right and marked system: it
        -- cannot be renamed, stripped or deleted. Without one such group a
        -- mistake on the rights screen can lock every administrator out of
        -- the rights screen, with no way back in through the API.
        IsSystem    BIT            NOT NULL CONSTRAINT DF_tblGroup_IsSystem DEFAULT (0),
        IsActive    BIT            NOT NULL CONSTRAINT DF_tblGroup_IsActive DEFAULT (1),

        CreatedBy   BIGINT             NULL,
        ModifiedBy  BIGINT             NULL,
        CreatedAt   DATETIME2(3)   NOT NULL CONSTRAINT DF_tblGroup_CreatedAt DEFAULT SYSUTCDATETIME(),
        ModifiedAt  DATETIME2(3)   NOT NULL CONSTRAINT DF_tblGroup_ModifiedAt DEFAULT SYSUTCDATETIME(),
        -- NULL means live. A deleted group's name is released for reuse,
        -- which is why the unique index below is filtered.
        DeletedAt   DATETIME2(3)       NULL
    );

    CREATE UNIQUE INDEX UQ_tblGroup_GroupName
        ON dbo.tblGroup (GroupName) WHERE DeletedAt IS NULL;
END
GO

-- ---------------------------------------------------------------------------
-- 4. dbo.tblAccessRight - the matrix. One row per group per module.
--
-- The six flags are NOT NULL DEFAULT 0, where the .NET table has them
-- nullable. A nullable bit gives three states for a two-state question and
-- made every read site write isnull(CanAdd, 0); absence of a row already
-- means "no access", so NULL adds a second way to say the same thing.
-- ---------------------------------------------------------------------------
IF OBJECT_ID('dbo.tblAccessRight', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblAccessRight (
        AccessId    BIGINT        NOT NULL IDENTITY(1, 1) CONSTRAINT PK_tblAccessRight PRIMARY KEY,

        GroupId     INT           NOT NULL,
        ModuleId    INT           NOT NULL,

        CanView     BIT           NOT NULL CONSTRAINT DF_tblAccessRight_CanView   DEFAULT (0),
        CanAdd      BIT           NOT NULL CONSTRAINT DF_tblAccessRight_CanAdd    DEFAULT (0),
        CanEdit     BIT           NOT NULL CONSTRAINT DF_tblAccessRight_CanEdit   DEFAULT (0),
        CanDelete   BIT           NOT NULL CONSTRAINT DF_tblAccessRight_CanDelete DEFAULT (0),
        CanPrint    BIT           NOT NULL CONSTRAINT DF_tblAccessRight_CanPrint  DEFAULT (0),
        CanMail     BIT           NOT NULL CONSTRAINT DF_tblAccessRight_CanMail   DEFAULT (0),

        CreatedBy   BIGINT            NULL,
        ModifiedBy  BIGINT            NULL,
        CreatedAt   DATETIME2(3)  NOT NULL CONSTRAINT DF_tblAccessRight_CreatedAt DEFAULT SYSUTCDATETIME(),
        ModifiedAt  DATETIME2(3)  NOT NULL CONSTRAINT DF_tblAccessRight_ModifiedAt DEFAULT SYSUTCDATETIME(),

        -- ON DELETE CASCADE: deleting a group must take its rights with it.
        -- The group API refuses to delete a group that still has members, so
        -- this fires only for an empty group.
        CONSTRAINT FK_tblAccessRight_Group FOREIGN KEY (GroupId)
            REFERENCES dbo.tblGroup (GroupId) ON DELETE CASCADE,
        CONSTRAINT FK_tblAccessRight_Module FOREIGN KEY (ModuleId)
            REFERENCES dbo.tblModule (ModuleId)
    );

    -- One row per pair, enforced by the database rather than by the upsert.
    -- Two administrators saving the same group at once would otherwise leave
    -- it with two contradictory rows and no way to say which one won.
    CREATE UNIQUE INDEX UQ_tblAccessRight_GroupModule
        ON dbo.tblAccessRight (GroupId, ModuleId);

    -- The resolver's only query: every right for one group.
    CREATE INDEX IX_tblAccessRight_Group ON dbo.tblAccessRight (GroupId) INCLUDE (ModuleId);
END
GO

-- ---------------------------------------------------------------------------
-- 5. The employee's group.
--
-- A single column, as tblManagingUser.GroupId is in the .NET portal: one
-- employee, one group. Two groups would mean deciding what "Add on module 4
-- from one and Delete on module 4 from the other" resolves to, and the whole
-- point of this model is that there is one place to look.
--
-- NULL is meaningful: an employee with no group has no access to anything.
-- That is the correct default for a new joiner.
-- ---------------------------------------------------------------------------
IF COL_LENGTH('dbo.tblEmployeeDetails', 'GroupId') IS NULL
BEGIN
    ALTER TABLE dbo.tblEmployeeDetails ADD GroupId INT NULL;
END
GO

IF OBJECT_ID('FK_tblEmployeeDetails_Group', 'F') IS NULL
BEGIN
    ALTER TABLE dbo.tblEmployeeDetails
        ADD CONSTRAINT FK_tblEmployeeDetails_Group FOREIGN KEY (GroupId)
            REFERENCES dbo.tblGroup (GroupId);
END
GO

-- Members of a group, for the mapping screen and for the delete guard.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_tblEmployeeDetails_GroupId')
BEGIN
    CREATE INDEX IX_tblEmployeeDetails_GroupId
        ON dbo.tblEmployeeDetails (GroupId) WHERE DeletedAt IS NULL;
END
GO

-- ---------------------------------------------------------------------------
-- 6. The cache stamp survives from 004, but may not exist on a database that
--    never ran it. Recreated here so this migration stands on its own.
-- ---------------------------------------------------------------------------
IF OBJECT_ID('dbo.tblAccessControlStamp', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblAccessControlStamp (
        StampId     BIGINT        NOT NULL IDENTITY(1, 1) CONSTRAINT PK_tblAccessControlStamp PRIMARY KEY,
        StampName   NVARCHAR(50)  NOT NULL,
        Version     BIGINT        NOT NULL CONSTRAINT DF_tblAccessControlStamp_Version DEFAULT (1),
        ModifiedAt  DATETIME2(3)  NOT NULL CONSTRAINT DF_tblAccessControlStamp_ModifiedAt DEFAULT SYSUTCDATETIME()
    );

    CREATE UNIQUE INDEX UQ_tblAccessControlStamp_StampName
        ON dbo.tblAccessControlStamp (StampName);
END
GO

IF NOT EXISTS (SELECT 1 FROM dbo.tblAccessControlStamp WHERE StampName = 'global')
BEGIN
    INSERT INTO dbo.tblAccessControlStamp (StampName, Version) VALUES ('global', 1);
END
GO
