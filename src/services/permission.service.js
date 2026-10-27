/**
 * The permission catalog, read-only.
 *
 * There is no create, update or delete here and there never should be: a
 * permission only means something because a route passes its code to
 * requirePermission(), so one invented through a screen would be a permission
 * nothing checks. src/enums/permission.enum.js is the source of truth and
 * scripts/seed-permissions.js the only writer.
 *
 * The ids come from the database rather than the enum, because the matrix
 * screens save by permissionId.
 */
import { query } from '../helpers/query.helper.js';
import { Permission, PERMISSION_PUBLIC_PROPS } from '../models/index.js';
import {
  PERMISSION_CATALOG,
  PERMISSION_MODULE_META,
  PERMISSION_SCOPES,
  PERMISSION_SCOPE_META,
  PERMISSION_SCOPE_RANK,
} from '../enums/index.js';

/** Catalog position by code, so the screen lists permissions in enum order. */
const CATALOG_ORDER = new Map(PERMISSION_CATALOG.map((entry, index) => [entry.code, index]));

/**
 * Every live permission, grouped by module, plus the scope dropdown's options.
 *
 * A permission the database holds but the enum has dropped cannot appear: the
 * seed retires it. One the enum lists but the database lacks does not appear
 * either, because the seed has not run - and a matrix that offered it would
 * save an id that does not exist.
 */
export async function getCatalog() {
  const rows = await query(
    `SELECT ${Permission.select(PERMISSION_PUBLIC_PROPS)}
       FROM ${Permission.table}
      WHERE DeletedAt IS NULL`,
  );

  const modules = new Map();

  for (const row of rows) {
    const meta = PERMISSION_MODULE_META[row.module] ?? { name: row.module, sortOrder: 9999 };

    if (!modules.has(row.module)) {
      modules.set(row.module, {
        code: row.module,
        name: meta.name,
        sortOrder: meta.sortOrder,
        permissions: [],
      });
    }

    modules.get(row.module).permissions.push({
      permissionId: Number(row.permissionId),
      code: row.permissionCode,
      module: row.module,
      action: row.action,
      description: row.description,
      isScoped: Boolean(row.isScoped),
      defaultScope: row.defaultScope,
      sortOrder: CATALOG_ORDER.get(row.permissionCode) ?? 9999,
    });
  }

  const sorted = [...modules.values()].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const module of sorted) module.permissions.sort((a, b) => a.sortOrder - b.sortOrder);

  return {
    modules: sorted,
    scopes: PERMISSION_SCOPES.map((value) => ({
      value,
      rank: PERMISSION_SCOPE_RANK[value],
      name: PERMISSION_SCOPE_META[value].name,
    })),
  };
}
