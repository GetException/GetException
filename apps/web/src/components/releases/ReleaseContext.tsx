import Link from "next/link";
import { linkTo } from "../../lib/search-params";
import {
  releaseEnvironments,
  releaseReviews,
  reviewLabel,
  type DeploymentSummary,
} from "./presentation";

export function ReleaseContext({
  projectId,
  deployments,
  showReviews = true,
}: {
  projectId: string;
  deployments: DeploymentSummary[];
  showReviews?: boolean;
}) {
  const environments = releaseEnvironments(deployments);

  return (
    <div className="release-context">
      {environments.length ? (
        environments.map(([environment, label]) => (
          <Link
            key={environment}
            className={`environment-badge environment-${environment}`}
            href={linkTo("/releases", { project: projectId, environment })}
          >
            {label}
          </Link>
        ))
      ) : (
        <span className="environment-badge environment-unknown">
          Unknown environment
        </span>
      )}
      {showReviews &&
        releaseReviews(deployments).map((review) => (
          <Link
            key={review}
            className="review-badge"
            href={linkTo("/releases", {
              project: projectId,
              environment: "staging",
              review,
            })}
          >
            {reviewLabel(review)} ↗
          </Link>
        ))}
    </div>
  );
}
