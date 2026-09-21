import Link from "next/link";
import { releaseLabel } from "../../lib/format";
import { linkTo } from "../../lib/search-params";
import {
  ENVIRONMENT_LABELS,
  releaseReviews,
  reviewLabel,
  type DeploymentSummary,
} from "../releases/presentation";

type Release = {
  id: string;
  deployments: DeploymentSummary[];
};

export function IssueBuildContext({
  projectId,
  environment,
  releaseName,
  release,
}: {
  projectId: string;
  environment: string;
  releaseName?: string | null;
  release?: Release | null;
}) {
  const reviews =
    environment === "staging" && release
      ? releaseReviews(
          release.deployments.filter((item) => item.environment === "staging"),
        )
      : [];
  const environmentLabel =
    ENVIRONMENT_LABELS[environment as keyof typeof ENVIRONMENT_LABELS] ??
    environment;

  return (
    <div className="issue-build-context">
      <span className={`environment-badge environment-${environment}`}>
        {environmentLabel}
      </span>
      {releaseName &&
        (release ? (
          <Link className="text-link mono" href={`/releases/${release.id}`}>
            ◇ {releaseLabel(releaseName)}
          </Link>
        ) : (
          <span className="mono muted">◇ {releaseLabel(releaseName)}</span>
        ))}
      {reviews.map((review) => (
        <Link
          key={review}
          className="review-badge"
          href={linkTo("/releases", {
            project: projectId,
            environment: "staging",
            review,
          })}
          title="This build is linked to this MR; the event does not contain a preview identifier."
        >
          {reviewLabel(review)} build
        </Link>
      ))}
      {reviews.length > 1 && (
        <span className="muted small">Build used in several MRs</span>
      )}
    </div>
  );
}
