/** Test-only: mirror cmd-verify reconcile orphan set diff. */
export function computeVectorSqliteOrphans(
  sqliteIds: string[],
  vectorIds: string[],
): { vectorOrphans: string[]; sqliteOrphans: string[] } {
  const sqliteSet = new Set(sqliteIds);
  const vectorSet = new Set(vectorIds);
  return {
    vectorOrphans: vectorIds.filter((id) => !sqliteSet.has(id)),
    sqliteOrphans: sqliteIds.filter((id) => !vectorSet.has(id)),
  };
}
