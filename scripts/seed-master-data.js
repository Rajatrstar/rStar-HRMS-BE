/**
 * Seeds every master-data list from the HRMS MASTERDATA export.
 *
 *   npm run db:seed:masterdata
 *
 * TWO GROUPS, ONE COMMAND. The five original lists - parent departments,
 * departments, designations, leave types and categories - come from the
 * per-list .xlsx exports of October 2025. The 23 below them come from the
 * yellow (dropdown) rows of "Zoho Master data.xlsx", whose own "Dropdown
 * Options" column IS the list: the options are typed out there, so they are
 * typed out here. Both groups seed the same way and both are idempotent, so
 * this stays one command rather than two somebody can forget half of.
 *
 * The values below are the Zoho export of October 2025 - Departments.xlsx,
 * Designation.xlsx, LeaveTypes.xlsx and Category.xlsx - transcribed once and
 * kept here rather than read from the spreadsheets at run time. A seed that
 * needed a .xlsx parser and four files sitting in somebody's Downloads folder
 * would not run on a fresh checkout, let alone in a deploy step.
 *
 * WHAT IS CARRIED OVER, AND WHAT IS NOT. Each list keeps its NAMES, and leave
 * types additionally keep the export's "Is Leave Type enabled" flag, which
 * lands in IsActive. Descriptions are left NULL: the export has none worth
 * keeping (the Category sheet's only non-empty one is "<div><br/></div>").
 * The export's own ids are deliberately dropped - they are Zoho's, these
 * tables have their own IDENTITY, and keeping a foreign system's keys around
 * invites somebody to join on them.
 *
 * PARENT DEPARTMENTS COME FROM THE DEPARTMENT SHEET: its "Parent Department"
 * column names three - Technology, Client Engagement and Operations - and all
 * three are also departments in their own right, which is why they appear in
 * both lists. A department with no parent in the export gets a NULL parent.
 *
 * Idempotent: a row whose name is already on file is left alone, so re-running
 * fills gaps and overwrites nothing. These rows are master data - once they
 * exist they are edited on their screen, not by re-running this.
 */
import { getPool, closePool } from '../src/config/db.js';
import { query, queryOne } from '../src/helpers/query.helper.js';
import {
  ParentDepartment,
  Department,
  Designation,
  LeaveType,
  Category,
  Gender,
  MaritalStatus,
  Relationship,
  Skill,
  EmploymentType,
  JobRole,
  EmployeeBand,
  WorkLocationCountry,
  WorkMode,
  BillabilityType,
  ProjectClient,
  CostCenter,
  SourceOfHire,
  OnboardingStatus,
  BackgroundVerificationStatus,
  TaxRegime,
  GovernmentIdType,
  DocumentType,
  DocumentVerificationStatus,
  AssetType,
  AssetModel,
  Qualification,
  Specialization,
} from '../src/models/index.js';
import { logger } from '../src/utils/logger.js';

/** The three values the export's "Parent Department" column takes. */
const PARENT_DEPARTMENTS = [
  "Client Engagement",
  "Operations",
  "Technology",
];

/** Every department, with the parent named in the export (null where blank). */
const DEPARTMENTS = [
  { name: "AI Transformation", parent: "Technology" },
  { name: "BA", parent: "Client Engagement" },
  { name: "CX", parent: "Technology" },
  { name: "Client Engagement", parent: null },
  { name: "Cyber Security", parent: "Technology" },
  { name: "Data & Integration", parent: "Technology" },
  { name: "Delivery", parent: "Technology" },
  { name: "HR", parent: "Operations" },
  { name: "IT Automation", parent: "Technology" },
  { name: "IT Transformation", parent: "Technology" },
  { name: "Innergy", parent: null },
  { name: "Legal", parent: "Operations" },
  { name: "Marketing", parent: "Client Engagement" },
  { name: "Operations", parent: null },
  { name: "Pre-Sales", parent: "Technology" },
  { name: "QA", parent: "Technology" },
  { name: "Recruiting", parent: "Operations" },
  { name: "Sales", parent: "Client Engagement" },
  { name: "Technology", parent: null },
];

/** Job titles. Duplicates in the export are collapsed - the name is unique. */
const DESIGNATIONS = [
  "Associate Trainee",
  "Associate Engineer",
  "Software Engineer",
  "Sr. Software Engineer",
  "Technical Lead",
  "Solution Architect / IT Manager",
  "Sr. IT Manager / Enterprise Architect",
  "Practice Lead / Director",
  "VP",
  "Associate QA Trainee",
  "Associate QA",
  "QA Engineer",
  "Senior QA Engineer",
  "QA Technical Lead",
  "QA Manager",
  "QA Architect",
  "QA Practice Lead",
  "Associate Project Manager / Project Coordinators",
  "Project Manager",
  "Senior Project Manager",
  "Program Manager",
  "Director of Delivery",
  "Developer",
  "Senior Business Consultant",
  "AIS Developer",
  "VP Operations",
  "VP Client Engagement",
  "VP IT",
  "Senior Developer - Full Stack",
  "Event Manager",
  "Oracle Apex Developer",
  "Sr. DevOps Engineer",
  "Customer Service Manager",
  "IT & Admin Support Executive",
  "Client Engagement Manager",
  "Client Partner Associate",
  "QA Analyst",
  "Client Partner",
  "Senior Client Partner",
  "Senior Marketing Associate",
  "Marketing Specialist",
  "Marketing Project Manager",
  "Sr. Graphic Designer",
  "Content Director",
  "HR Specialist",
  "Senior HR Manager",
  "Delphi Developer",
  "Product Coordinator",
  "Desktop Application Architect",
  "Fast API Developer",
  "Presales Architect",
  "Azure Ai Developer",
  "Node JS Developer",
  "React JS Developer",
  "DevOps Engineer",
  "CMO",
  "Senior Manager Demand Generation",
  "Senior AIS Engineer",
  "Managing Director",
  "PMO/Delivery Manager",
  "QA Lead",
  "Legal Executive",
  "Security Architect",
  "Senior Tech Lead",
  "Senior PO & Business Analyst",
  "Senior Business Analyst",
  "Technical Project Manager",
  "Solution Architect",
  "Senior Solution Lead",
  "Administrative Assistant",
  "Boomi Integration Developer",
  "Senior Software Engineer",
  "Manager – Finance, Resources & Operations",
  "Azure Integration Services Architect/Developer",
  "Sr. Manager – Finance, Resources & Operations",
  "Sr. QA Engineer",
  "Sr. Delivery Manager",
  "Foundation Architect",
  "Client Engagement Associate",
  "Associate Delivery Director",
  "Sr. Technical Writer",
  "Sr. Technical Manager",
  "Practice Lead",
  "ISO Certification Lead",
  "Sr. Talent Acquisition Specialist",
  "Software Trainee",
  "Admin Assistant/QA Trainee",
  "Sr. Marketing Coordinator",
  "Functional Lead",
  "Sr. Business Functional Analyst",
  "Cybersecurity Specialist",
  "Platform Solution Architect",
  "Director/Practice Lead AI/ML Innovation and DevSecOps",
  "Cyber Security Lead",
  "Gen AI Fullstack Developer",
  "MuleSoft Developer",
  "Presales Consultant",
  "Marketing Associate",
  "Fullstack Developer",
  "Lead DevOps Engineer",
  "Senior HR Analyst",
  "Graphic Designer",
  "Graphic/UI UX Designer",
  "Reactnative Developer",
  "SAP Lead",
  "Social Media Specialist",
  "Manual QA Engineer",
  "Support Release Manager",
  "Salesforce Developer",
  "Marketing Director",
  "Manufacturing Cloud Architect",
  "Utilities Practice Lead",
  "Integration Architect",
  "Middleware Architect",
  "Director of Partner Growth and Innovation",
  "Scrum Master",
  "Program Manager/Delivery Director",
  "General Manager - HR",
  "SAP Technical Consultant",
  "Technical Delivery Governance Lead",
  "Integration Developer",
  "Sr. HR Executive",
  "Recruitment Trainee",
  "Practice Lead - IT Transformation ( Offshore)",
  "Practice Lead- IT Transformation.",
  "Practice Lead- CX",
  "Practice Lead- SAP",
  "Tech Lead- AI Automation",
  "Practice Lead- Data and Integration",
  "Associate Software Engineer",
  "Admin Assistant/Associate QA",
  "Associate Project Manager",
  "QA Automation Engineer",
  "Graphic/ UI Designer",
  "Solution Architect/ IT Manager",
  "Senior Technical Manager",
  "Director/ Practice Lead",
  "CTO",
  "QA Trainee",
  "Web developer",
  "Technical Admin Assistant",
  "VP. Operations/ Project Manager",
  "Product Quality Lead",
  "Delivery Director/Client Partner Growth",
  "Associate QA Engineer",
  "Talent Acquisition Specialist",
  "Sr. Scrum Master",
  "Sr. Business Consultant",
  "HR Trainee",
  "VP Operations/Sr.Project Manager",
  "HR Manager",
  "Business Analyst",
  "Call Center Expert",
  "Creative Lead",
  "Technical Delivery Coordinator",
  "Marketing Lead",
  "Client Engagement Trainee",
  "Software Engineering Trainee",
  "Content Writer",
  "Client Parter - Strategy and Growth",
  "Client Partner - Strategy and Growth",
  "Full Stack Engineer",
  "Sales Consultant",
  "Content Marketing Manager",
  "Digital Marketing Automation Lead",
  "Associate S",
  "Marketing Lead Gen and Automation manager",
  "Dynamics CRM",
  "Senior Power BI Data Engineer",
  "Technical Data Lead",
  "Digital Marketing & Content Lead",
  "Data Integration & Analytics Analyst",
];

/** Leave types. `isActive` is the export's "Is Leave Type enabled". */
const LEAVE_TYPES = [
  { name: "Absent", isActive: true },
  { name: "Compensatory Off", isActive: false },
  { name: "Leave Without Pay", isActive: true },
  { name: "Sabbatical Leave", isActive: true },
  { name: "Casual & Sick Leave", isActive: true },
  { name: "Earned Leave", isActive: true },
  { name: "Vacation days US", isActive: true },
  { name: "Casual Leave Contractors", isActive: true },
  { name: "Sick Leave US", isActive: true },
  { name: "Paternity Leave", isActive: false },
  { name: "Paternity Leave - India", isActive: true },
  { name: "Medical Leave - Deepak Mishra", isActive: false },
  { name: "Comp Off - US", isActive: false },
  { name: "Comp Off- IN", isActive: true },
  { name: "CompOff - US", isActive: true },
  { name: "Floating - IN", isActive: false },
  { name: "Floating Holiday - IN", isActive: true },
];

/** Help-desk and announcement categories. */
const CATEGORIES = [
  "Announcements",
  "Ask your manager",
  "Attendance",
  "Azure",
  "Compensation",
  "Custom permissions",
  "General",
  "HR Letters",
  "IT",
  "Leave Tracker",
  "Organization",
  "Performance",
  "Reimbursements",
  "Time Tracker",
  "Travel",
  "HR Help Desk",
  "IT Help Desk",
];

/**
 * The employee-form dropdown lists, from the yellow rows of
 * "Zoho Master data.xlsx". Every value below is transcribed from that sheet's
 * "Dropdown Options" column, in the order it is written there.
 *
 * THREE LISTS ARE DELIBERATELY EMPTY. Projects/clients, cost centers and
 * asset models are described in the sheet only as "admin-maintained list" -
 * it names no options, because the options are whatever the company has this
 * quarter. Seeding a guess would put rows on the screen that somebody then
 * has to work out whether to trust. They are created empty and filled in on
 * their own screen.
 *
 * WHAT IS NOT HERE, because the sheet's yellow rows already have a home:
 * Designation and Department (seeded above), Employee Status and WFO Required
 * (columns on tblEmployeeDetails), System Role (user groups), Office/Seating
 * Location and Legal Entity (organisation locations and organisations),
 * Additional Accessories (reads asset types) and the dependent's Relationship
 * (reads relationships). See db/migrations/010 for the reasoning.
 */
const DROPDOWN_LISTS = [
  {
    label: 'genders',
    model: Gender,
    idProp: 'genderId',
    values: [
      "Female", "Male", "Non-binary", "Prefer not to say", "Other",
    ],
  },
  {
    label: 'marital statuses',
    model: MaritalStatus,
    idProp: 'maritalStatusId',
    values: [
      "Single", "Married", "Separated", "Divorced", "Widowed", "Prefer not to say",
    ],
  },
  {
    label: 'relationships',
    model: Relationship,
    idProp: 'relationshipId',
    values: [
      "Spouse", "Father", "Mother", "Brother", "Sister", "Child", "Other",
    ],
  },
  {
    label: 'skills',
    model: Skill,
    idProp: 'skillId',
    values: [
      "AI / Generative AI", "AI Automation", "Application Development", "Business Analysis",
      "Cloud", "Data & Analytics", "Data Integration", "DevOps", "Cybersecurity",
      "Dynamics CRM", "HR / People Operations", "IT Transformation", "Marketing",
      "Project Management", "Quality Assurance", "Recruiting / Talent Acquisition",
      "Software Engineering", "Technical Support", "Other",
    ],
  },
  {
    label: 'employment types',
    model: EmploymentType,
    idProp: 'employmentTypeId',
    values: [
      "Permanent", "On Contract", "Probation", "Trainee", "Intern", "Fixed-term", "Consultant",
    ],
  },
  {
    label: 'job roles',
    model: JobRole,
    idProp: 'jobRoleId',
    values: [
      "Individual Contributor", "Team Lead", "People Manager", "Project Manager",
      "Practice Lead", "Director", "Vice President", "Executive Leadership", "Other",
    ],
  },
  {
    label: 'employee bands',
    model: EmployeeBand,
    idProp: 'employeeBandId',
    values: [
      "A1", "A2", "B1", "B2", "B3", "C1", "C2", "C3", "D", "Other",
    ],
  },
  {
    label: 'work location countries',
    model: WorkLocationCountry,
    idProp: 'workLocationCountryId',
    values: [
      "India", "US", "Other",
    ],
  },
  {
    label: 'work modes',
    model: WorkMode,
    idProp: 'workModeId',
    values: [
      "Office", "Hybrid", "Remote", "Client Site",
    ],
  },
  {
    label: 'billability types',
    model: BillabilityType,
    idProp: 'billabilityTypeId',
    values: [
      "Billable", "Non-Billable", "Billable / Non-Billable", "Not Applicable",
    ],
  },
  {
    label: 'projects/clients',
    model: ProjectClient,
    idProp: 'projectClientId',
    // Admin-maintained: the sheet names no options.
    values: [],
  },
  {
    label: 'cost centers',
    model: CostCenter,
    idProp: 'costCenterId',
    // Admin-maintained: the sheet names no options.
    values: [],
  },
  {
    label: 'sources of hire',
    model: SourceOfHire,
    idProp: 'sourceOfHireId',
    values: [
      "Direct", "Referral", "Recruitment Agency", "Job Portal", "Campus", "Internal Transfer",
      "Other",
    ],
  },
  {
    label: 'onboarding statuses',
    model: OnboardingStatus,
    idProp: 'onboardingStatusId',
    values: [
      "Not Triggered", "Pending", "In Progress", "Completed", "On Hold", "Cancelled",
    ],
  },
  {
    label: 'background verification statuses',
    model: BackgroundVerificationStatus,
    idProp: 'backgroundVerificationStatusId',
    values: [
      "Not Initiated", "Initiated", "In Progress", "Completed", "Discrepancy", "On Hold",
      "Not Applicable",
    ],
  },
  {
    label: 'tax regimes',
    model: TaxRegime,
    idProp: 'taxRegimeId',
    values: [
      "New", "Old", "Not Applicable",
    ],
  },
  {
    label: 'government id types',
    model: GovernmentIdType,
    idProp: 'governmentIdTypeId',
    values: [
      "Aadhaar", "PAN", "Passport", "SSN", "Other",
    ],
  },
  {
    label: 'document types',
    model: DocumentType,
    idProp: 'documentTypeId',
    values: [
      "Offer Letter", "Employment Agreement", "NDA", "Employee Handbook Acknowledgement",
      "Identity Proof", "Address Proof", "PAN Card", "Aadhaar Card", "Resume",
      "Education Certificate", "Experience Letter", "Relieving Letter", "Certification",
      "Other",
    ],
  },
  {
    label: 'document verification statuses',
    model: DocumentVerificationStatus,
    idProp: 'documentVerificationStatusId',
    values: [
      "Pending", "Verified", "Rejected", "Expired", "Not Applicable",
    ],
  },
  {
    label: 'asset types',
    model: AssetType,
    idProp: 'assetTypeId',
    values: [
      "Laptop", "Desktop", "Monitor", "Mobile Phone", "Tablet", "Headset / Earbuds", "Mouse",
      "Keyboard", "Other",
    ],
  },
  {
    label: 'asset models',
    model: AssetModel,
    idProp: 'assetModelId',
    // Admin-maintained: the sheet names no options.
    values: [],
  },
  {
    label: 'qualifications',
    model: Qualification,
    idProp: 'qualificationId',
    values: [
      "High School", "Diploma", "Bachelor's Degree", "Master's Degree", "Doctorate",
      "Professional Certification", "Other",
    ],
  },
  {
    label: 'specializations',
    model: Specialization,
    idProp: 'specializationId',
    values: [
      "Computer Science", "Information Technology", "Engineering", "Business Administration",
      "Data Science / Analytics", "Finance", "Human Resources", "Marketing", "Other",
    ],
  },
];

/**
 * Inserts one row unless a live one already has that name.
 *
 * Two statements rather than one MERGE: this runs once, by hand, against a
 * list of a few hundred names, and a SELECT that says plainly what it is
 * checking is worth more here than saving a round trip.
 *
 * @returns {Promise<{ id: number, inserted: boolean }>}
 */
async function ensureRow(model, idProp, { name, parentDepartmentId = undefined, isActive = true }) {
  const existing = await queryOne(
    `SELECT TOP (1) ${model.col(idProp)} AS id
       FROM ${model.table}
      WHERE ${model.col('name')} = @name
        AND ${model.col('deletedAt')} IS NULL`,
    model.params({ name }),
  );

  if (existing) return { id: Number(existing.id), inserted: false };

  const columns = [model.col('name'), model.col('isActive')];
  const values = ['@name', '@isActive'];
  const params = model.params({ name, isActive });

  if (parentDepartmentId !== undefined) {
    columns.push(model.col('parentDepartmentId'));
    values.push('@parentDepartmentId');
    Object.assign(params, model.params({ parentDepartmentId }));
  }

  const [row] = await query(
    `INSERT INTO ${model.table} (${columns.join(', ')})
     OUTPUT inserted.${model.col(idProp)} AS id
     VALUES (${values.join(', ')})`,
    params,
  );

  return { id: Number(row.id), inserted: true };
}

/** Seeds one flat list and reports how much of it was new. */
async function seedList(label, model, idProp, rows) {
  let inserted = 0;

  for (const row of rows) {
    const outcome = await ensureRow(model, idProp, typeof row === 'string' ? { name: row } : row);
    if (outcome.inserted) inserted += 1;
  }

  logger.info(`  ${label}: ${inserted} added, ${rows.length - inserted} already on file`);
}

async function run() {
  await getPool();

  logger.info('Seeding master data');

  // Parents first: a department cannot point at one that is not there yet.
  const parentIds = new Map();
  let newParents = 0;

  for (const name of PARENT_DEPARTMENTS) {
    const outcome = await ensureRow(ParentDepartment, 'parentDepartmentId', { name });
    parentIds.set(name, outcome.id);
    if (outcome.inserted) newParents += 1;
  }

  logger.info(
    `  parent departments: ${newParents} added, ` +
      `${PARENT_DEPARTMENTS.length - newParents} already on file`,
  );

  let newDepartments = 0;

  for (const department of DEPARTMENTS) {
    const outcome = await ensureRow(Department, 'departmentId', {
      name: department.name,
      // A parent named in the sheet but missing from PARENT_DEPARTMENTS would
      // be a transcription error, so this throws rather than quietly storing
      // a top-level department.
      parentDepartmentId: department.parent === null ? null : parentIdFor(parentIds, department),
    });
    if (outcome.inserted) newDepartments += 1;
  }

  logger.info(
    `  departments: ${newDepartments} added, ` +
      `${DEPARTMENTS.length - newDepartments} already on file`,
  );

  await seedList('designations', Designation, 'designationId', DESIGNATIONS);
  await seedList('leave types', LeaveType, 'leaveTypeId', LEAVE_TYPES);
  await seedList('categories', Category, 'categoryId', CATEGORIES);

  // The employee-form dropdowns. Same loop, same idempotence; an empty list
  // says so rather than reporting "0 added" and looking like a failure.
  for (const list of DROPDOWN_LISTS) {
    if (list.values.length === 0) {
      logger.info(`  ${list.label}: admin-maintained, nothing to seed`);
      continue;
    }
    await seedList(list.label, list.model, list.idProp, list.values);
  }

  logger.info('');
  logger.info('Master data is on file. Edit it at /api/v1/organizations/...');

  await closePool();
}

function parentIdFor(parentIds, department) {
  const id = parentIds.get(department.parent);
  if (id === undefined) {
    throw new Error(
      `Department "${department.name}" names parent "${department.parent}", ` +
        'which is not in PARENT_DEPARTMENTS.',
    );
  }
  return id;
}

run().catch(async (error) => {
  logger.error('Seeding master data failed', error);
  await closePool();
  process.exit(1);
});
