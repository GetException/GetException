import { releaseLabel } from "../../lib/format";

export function NewInRelease({
  release,
  appVersion,
}: {
  release: string;
  appVersion?: string | null;
}) {
  return (
    <span
      className="pill new-in-release"
      title="First observed in this release in this environment, within retained history"
    >
      New in {releaseLabel(release, appVersion)}
    </span>
  );
}
