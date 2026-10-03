import { sortValues, type TableSort } from "../../lib/table-sort";

export function SortFields({
  sorting,
  prefix,
}: {
  sorting: TableSort;
  prefix?: string;
}) {
  return (
    <>
      {Object.entries(sortValues(sorting, prefix)).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}
