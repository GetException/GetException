export function Status({
  status,
  regression = false,
}: {
  status: string;
  regression?: boolean;
}) {
  return (
    <span
      className={`pill status ${regression && status === "open" ? "regression" : status === "resolved" ? "resolved" : ""}`}
    >
      {regression && status === "open" ? "Regression" : status}
    </span>
  );
}
